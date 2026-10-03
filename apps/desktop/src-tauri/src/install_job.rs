//! A background install the Projects page starts, polls and cancels: the shared
//! machinery behind the Chrome button (`chrome_install`) and the FFmpeg button
//! (`ffmpeg_install`, Homebrew).
//!
//! One `InstallJob` per tool, each holding one slot:
//!
//! - `start` spawns the installer's command and a supervisor thread that owns
//!   the `Child`, feeds its output lines to the installer and updates the slot.
//!   Starting while a job runs just returns the running job.
//! - `state` returns the slot. A finished job (`done`, `failed`, `cancelled`)
//!   stays there until the next `start`.
//! - `cancel` asks the child's tree to stop, answers `cancelled` at once and
//!   forcibly stops the tree after the grace period if it is still alive.
//! - `shutdown` (app exit) does the same and waits for the tree to go.
//! - A watchdog fails and kills a job that outlives the installer's timeout.
//!
//! Neither the slot's mutex nor the home server's state mutex is held across
//! I/O or while an installer hook that does I/O runs: handlers and the
//! supervisor lock briefly, copy, release.

use std::io::{BufRead, BufReader};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use super::cli_runner;
use super::coded_error::CodedError;

/// `idle` · `checking` · `downloading` · `installing` · `done` · `failed` · `cancelled`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstallState {
    pub phase: &'static str,
    /// Bytes downloaded / expected, while the installer reports them (Chrome).
    pub downloaded: Option<u64>,
    pub total: Option<u64>,
    /// The current human-readable line of the installer's output, while it has
    /// no byte progress to report (Homebrew).
    pub detail: Option<String>,
    /// `done`: the installed tool's executable.
    pub path: Option<String>,
    /// `done` (Chrome): `cache` (it was already there), `download` or `env`.
    pub source: Option<String>,
    /// `failed`: one line.
    pub error: Option<String>,
    /// `failed`: the stable code of `error` and the values it mentions, when the page can translate it
    /// (`home.error.<code>`). A failure that is a tool's own output has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl InstallState {
    pub const IDLE: InstallState = InstallState {
        phase: "idle",
        downloaded: None,
        total: None,
        detail: None,
        path: None,
        source: None,
        error: None,
        code: None,
        params: None,
    };

    pub fn of(phase: &'static str) -> Self {
        Self { phase, ..Self::IDLE }
    }

    /// A failure with text that is not ours (a tool's own output): no code.
    pub fn failed(message: &str) -> Self {
        let mut state = Self::of("failed");
        state.error = Some(one_line(message, 300));
        state
    }

    pub fn failed_with(err: &CodedError) -> Self {
        let mut state = Self::failed(&err.message);
        state.code = err.code;
        state.params = err.code.map(|_| err.params.clone());
        state
    }

    pub fn is_active(&self) -> bool {
        matches!(self.phase, "checking" | "downloading" | "installing")
    }
}

/// The first non-empty line of `message`, bounded to `max` characters.
pub fn one_line(message: &str, max: usize) -> String {
    message
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("the installer failed")
        .chars()
        .take(max)
        .collect()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// What the supervisor does after the process exited while the job was still active.
#[derive(Debug, PartialEq, Eq)]
pub enum ExitAction {
    /// `on_exit` left the final state in place.
    Finished,
    /// The process succeeded: run `Installer::verify` (outside the lock), then
    /// finish `done` or `failed`.
    Verify,
    /// Run the command again (`attempt + 1`).
    Retry,
}

pub trait Installer: Sync {
    /// The command to run, stdout piped. `attempt` is 0 for the first run.
    /// It must go through `cli_runner::command` (or at least
    /// `crate::proc::configure`); `InstallJob::spawn` applies the supervision
    /// flags again, so both paths land in the child's tree.
    fn command(&self, attempt: u32) -> Result<Command, CodedError>;
    /// The state a freshly started job begins in.
    fn started(&self) -> InstallState;
    /// One line of output. Called with the slot locked: no I/O here.
    fn on_line(&self, state: &mut InstallState, stream: Stream, line: &str);
    /// The process exited and the job was still active. `stderr_tail` is the
    /// last stderr lines. Called with the slot locked: no I/O here.
    fn on_exit(
        &self,
        state: &mut InstallState,
        status: &ExitStatus,
        stderr_tail: &[String],
        attempt: u32,
    ) -> ExitAction;
    /// After a successful exit: check the result (may do I/O). `Ok(Some(path))`
    /// is the installed tool, `Ok(None)` an unverifiable but accepted result.
    fn verify(&self) -> Result<Option<String>, CodedError> {
        Ok(None)
    }
}

const TAIL_LINES: usize = 12;

pub(crate) struct Slot {
    pub(crate) state: InstallState,
    /// Bumped by every `start`, so a finished supervisor never writes over a newer job.
    pub(crate) generation: u64,
    /// The process group leader while it is alive and not yet reaped.
    pub(crate) pid: Option<u32>,
    pub(crate) tail: Vec<String>,
}

pub struct InstallJob {
    slot: Mutex<Slot>,
    installer: &'static dyn Installer,
    timeout: Duration,
}

impl InstallJob {
    pub const fn new(installer: &'static dyn Installer, timeout: Duration) -> Self {
        Self {
            slot: Mutex::new(Slot {
                state: InstallState::IDLE,
                generation: 0,
                pid: None,
                tail: Vec::new(),
            }),
            installer,
            timeout,
        }
    }

    pub(crate) fn slot(&self) -> MutexGuard<'_, Slot> {
        self.slot.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Run `f` with the slot locked. For in-process installers (the Windows
    /// FFmpeg download has no child to supervise) that must mutate the slot
    /// directly; process installers keep using `start`/`cancel`/`shutdown`.
    pub(crate) fn with_slot<R>(&self, f: impl FnOnce(&mut Slot) -> R) -> R {
        f(&mut self.slot())
    }

    pub fn state(&self) -> InstallState {
        self.slot().state.clone()
    }

    /// Start the install, or return the one already running.
    pub fn start(&'static self) -> InstallState {
        let mut slot = self.slot();
        if slot.state.is_active() {
            return slot.state.clone();
        }
        slot.generation += 1;
        let generation = slot.generation;
        slot.tail.clear();
        match self.spawn(0) {
            Ok(child) => {
                slot.pid = Some(child.id());
                slot.state = self.installer.started();
                std::thread::spawn(move || self.supervise(child, generation, 0));
                std::thread::spawn(move || self.watchdog(generation));
            }
            Err(message) => {
                slot.pid = None;
                slot.state = InstallState::failed_with(&message);
            }
        }
        slot.state.clone()
    }

    fn spawn(&self, attempt: u32) -> Result<std::process::Child, CodedError> {
        let mut command = self.installer.command(attempt)?;
        command.stdin(Stdio::null()).stdout(Stdio::piped());
        // Belt and suspenders with `Installer::command`: the flags are
        // idempotent, so a forgotten call site still lands supervised.
        crate::proc::configure(&mut command);
        let child = command.spawn().map_err(|e| {
            CodedError::new(
                "installer_start_failed",
                format!("could not start the installer: {e}"),
                json!({ "detail": e.to_string() }),
            )
        })?;
        crate::proc::track(&child);
        Ok(child)
    }

    fn feed(&self, generation: u64, stream: Stream, line: &str) {
        let mut slot = self.slot();
        if slot.generation != generation || !slot.state.is_active() {
            return;
        }
        if stream == Stream::Stderr {
            slot.tail.push(line.to_string());
            let excess = slot.tail.len().saturating_sub(TAIL_LINES);
            slot.tail.drain(..excess);
        }
        let Slot { state, .. } = &mut *slot;
        self.installer.on_line(state, stream, line);
    }

    fn supervise(&'static self, mut child: std::process::Child, generation: u64, mut attempt: u32) {
        loop {
            let stderr_reader = child.stderr.take().map(|stderr| {
                std::thread::spawn(move || {
                    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                        self.feed(generation, Stream::Stderr, &line);
                    }
                })
            });
            // Blocking read: returns when the leader exits AND every stdout
            // inheritor is gone (the tree kill in `stop_group`/watchdog plus
            // this process's own `kill_group_now` below guarantee that — the
            // cancel path cannot return while a grandchild holds the pipe).
            if let Some(stdout) = child.stdout.take() {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    self.feed(generation, Stream::Stdout, &line);
                }
            }
            let status = child.wait();
            // Stragglers of the group (a lingering Chrome, a brew helper) must
            // not outlive the run, and must not keep the stderr pipe open.
            cli_runner::kill_group_now(child.id());
            if let Some(reader) = stderr_reader {
                let _ = reader.join();
            }

            let action = {
                let mut slot = self.slot();
                if slot.generation != generation {
                    return;
                }
                slot.pid = None;
                if !slot.state.is_active() {
                    return;
                }
                match &status {
                    Ok(status) => {
                        let tail = slot.tail.clone();
                        let Slot { state, .. } = &mut *slot;
                        self.installer.on_exit(state, status, &tail, attempt)
                    }
                    Err(err) => {
                        slot.state = InstallState::failed_with(&CodedError::new(
                            "installer_stopped",
                            format!("the installer stopped unexpectedly ({err})"),
                            json!({ "status": err.to_string() }),
                        ));
                        ExitAction::Finished
                    }
                }
            };
            match action {
                ExitAction::Finished => return,
                ExitAction::Verify => {
                    let verified = self.installer.verify();
                    let mut slot = self.slot();
                    if slot.generation == generation && slot.state.is_active() {
                        slot.state = match verified {
                            Ok(path) => {
                                let mut done = InstallState::of("done");
                                done.path = path;
                                done
                            }
                            Err(message) => InstallState::failed_with(&message),
                        };
                    }
                    return;
                }
                ExitAction::Retry => {
                    attempt += 1;
                    let mut slot = self.slot();
                    // Cancelled (or timed out) between the exit and now: do not run again.
                    if slot.generation != generation || !slot.state.is_active() {
                        return;
                    }
                    slot.tail.clear();
                    match self.spawn(attempt) {
                        Ok(next) => {
                            slot.pid = Some(next.id());
                            child = next;
                        }
                        Err(message) => {
                            slot.state = InstallState::failed_with(&message);
                            return;
                        }
                    }
                }
            }
        }
    }

    /// Fails and kills a job that runs past the installer's timeout.
    fn watchdog(&'static self, generation: u64) {
        let deadline = Instant::now() + self.timeout;
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(250));
            let slot = self.slot();
            if slot.generation != generation || !slot.state.is_active() {
                return;
            }
        }
        let pid = {
            let mut slot = self.slot();
            if slot.generation != generation || !slot.state.is_active() {
                return;
            }
            let minutes = self.timeout.as_secs() / 60;
            slot.state = InstallState::failed_with(&CodedError::new(
                "install_timeout",
                format!("the install took longer than {minutes} minutes and was stopped"),
                json!({ "minutes": minutes }),
            ));
            slot.pid
        };
        self.stop_group(pid, generation);
    }

    /// Ask the tree to stop now, forcibly stop it after the grace period unless the supervisor reaped it first.
    fn stop_group(&'static self, pid: Option<u32>, generation: u64) {
        let Some(pid) = pid else { return };
        cli_runner::terminate_group(pid);
        std::thread::spawn(move || {
            let deadline = Instant::now() + cli_runner::TERM_GRACE;
            while Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
                if self.slot().pid != Some(pid) {
                    return;
                }
            }
            let slot = self.slot();
            if slot.generation == generation && slot.pid == Some(pid) {
                cli_runner::kill_group_now(pid);
            }
        });
    }

    /// Cancel the running install. A no-op (returning the state) when none runs.
    pub fn cancel(&'static self) -> InstallState {
        let (pid, generation) = {
            let mut slot = self.slot();
            if !slot.state.is_active() {
                return slot.state.clone();
            }
            slot.state = InstallState::of("cancelled");
            (slot.pid, slot.generation)
        };
        self.stop_group(pid, generation);
        self.state()
    }

    /// App exit: stop a running install and wait (bounded) for its group to go.
    pub fn shutdown(&self) {
        let pid = {
            let mut slot = self.slot();
            if !slot.state.is_active() {
                return;
            }
            slot.state = InstallState::of("cancelled");
            slot.pid
        };
        let Some(pid) = pid else { return };
        cli_runner::terminate_group(pid);
        let deadline = Instant::now() + cli_runner::TERM_GRACE;
        while Instant::now() < deadline && self.slot().pid == Some(pid) {
            std::thread::sleep(Duration::from_millis(50));
        }
        cli_runner::kill_group_now(pid);
    }

    #[cfg(test)]
    pub fn reset(&self) {
        let mut slot = self.slot();
        slot.state = InstallState::IDLE;
        slot.pid = None;
        slot.generation += 1;
        slot.tail.clear();
    }

    #[cfg(test)]
    pub fn pid(&self) -> Option<u32> {
        self.slot().pid
    }

    #[cfg(test)]
    pub fn generation(&self) -> u64 {
        self.slot().generation
    }
}

#[cfg(test)]
pub mod test_support {
    use super::*;

    pub fn wait_for(
        job: &InstallJob,
        what: &str,
        done: impl Fn(&InstallState) -> bool,
    ) -> InstallState {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let now = job.state();
            if done(&now) {
                return now;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}: {now:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn process_alive(pid: u32) -> bool {
        crate::proc::is_alive(pid)
    }

    pub fn wait_until_gone(pid: u32) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while process_alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!process_alive(pid), "process {pid} is still alive");
    }
}
