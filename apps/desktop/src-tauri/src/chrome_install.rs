//! The "Install Chrome" button: start + poll + cancel around the CLI's own
//! `hyperframes browser ensure --json`, which downloads the pinned managed
//! Chrome headless shell into the CLI cache (`~/.cache/hyperframes/chrome`).
//! No download logic lives here; the job machinery is `install_job`.
//!
//! The CLI prints one JSON object per line: `start`, `progress` (bytes),
//! `done {path, source}`, `error {message}`. On SIGTERM it releases its install
//! lock and deletes the unfinished archive.

use std::process::{Command, ExitStatus};
use std::time::Duration;

use serde_json::{json, Value};

use super::cli_runner;
use super::coded_error::CodedError;
use super::install_job::{one_line, ExitAction, InstallJob, InstallState, Installer, Stream};

struct ChromeInstaller;

/// Fold one CLI event into the state. Unknown events are ignored.
pub fn apply_event(state: &mut InstallState, event: &Value) {
    match event.get("event").and_then(Value::as_str) {
        Some("start") => *state = InstallState::of("checking"),
        Some("progress") => {
            let downloaded = event.get("downloaded").and_then(Value::as_u64);
            let total = event.get("total").and_then(Value::as_u64).filter(|t| *t > 0);
            // The archive is complete but the CLI has not said done: it is unpacking.
            let complete = matches!((downloaded, total), (Some(d), Some(t)) if d >= t);
            state.phase = if complete { "installing" } else { "downloading" };
            state.downloaded = downloaded;
            state.total = total;
        }
        Some("done") => {
            *state = InstallState::of("done");
            state.path = event.get("path").and_then(Value::as_str).map(str::to_string);
            state.source = event.get("source").and_then(Value::as_str).map(str::to_string);
        }
        Some("error") => {
            *state = InstallState::of("failed");
            state.error = Some(one_line(
                event.get("message").and_then(Value::as_str).unwrap_or(""),
                300,
            ));
        }
        _ => {}
    }
}

impl Installer for ChromeInstaller {
    fn command(&self, _attempt: u32) -> Result<Command, CodedError> {
        cli_runner::command(&["browser", "ensure", "--json"])
    }

    fn started(&self) -> InstallState {
        InstallState::of("checking")
    }

    fn on_line(&self, state: &mut InstallState, stream: Stream, line: &str) {
        if stream != Stream::Stdout {
            return;
        }
        if let Ok(event) = serde_json::from_str::<Value>(line.trim()) {
            apply_event(state, &event);
        }
    }

    fn on_exit(
        &self,
        state: &mut InstallState,
        status: &ExitStatus,
        _stderr_tail: &[String],
        _attempt: u32,
    ) -> ExitAction {
        // Still active: the CLI died without saying done or error.
        *state = InstallState::failed_with(&CodedError::new(
            "installer_stopped",
            format!("the installer stopped unexpectedly ({status})"),
            json!({ "status": status.to_string() }),
        ));
        ExitAction::Finished
    }
}

/// Downloading ~100 MB; half an hour is generous even on a bad connection.
static JOB: InstallJob = InstallJob::new(&ChromeInstaller, Duration::from_secs(30 * 60));

pub fn state() -> InstallState {
    JOB.state()
}

pub fn start() -> InstallState {
    JOB.start()
}

pub fn cancel() -> InstallState {
    JOB.cancel()
}

pub fn shutdown() {
    JOB.shutdown()
}

#[cfg(test)]
#[allow(dead_code)]
pub fn reset() {
    JOB.reset()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_runner::tests::with_fake_cli;
    use crate::install_job::test_support::{process_alive, wait_for, wait_until_gone};
    use serde_json::json;
    use std::time::Instant;

    #[test]
    fn events_fold_into_phases() {
        let mut s = InstallState::IDLE;
        apply_event(&mut s, &json!({"event":"start"}));
        assert_eq!(s.phase, "checking");
        apply_event(&mut s, &json!({"event":"progress","downloaded":10,"total":100}));
        assert_eq!((s.phase, s.downloaded, s.total), ("downloading", Some(10), Some(100)));
        apply_event(&mut s, &json!({"event":"progress","downloaded":100,"total":100}));
        assert_eq!(s.phase, "installing");
        apply_event(&mut s, &json!({"event":"mystery"}));
        assert_eq!(s.phase, "installing");
        apply_event(&mut s, &json!({"event":"done","path":"/c/chrome","source":"download"}));
        assert_eq!((s.phase, s.path.as_deref(), s.source.as_deref()), ("done", Some("/c/chrome"), Some("download")));
        assert_eq!(s.downloaded, None);
        apply_event(&mut s, &json!({"event":"error","message":"\n  Failed: no network\nsecond line"}));
        assert_eq!((s.phase, s.error.as_deref()), ("failed", Some("Failed: no network")));
        // An unknown total is not a zero total.
        apply_event(&mut s, &json!({"event":"progress","downloaded":5,"total":0}));
        assert_eq!((s.phase, s.total), ("downloading", None));
    }

    #[test]
    fn an_install_runs_to_done_and_a_second_start_while_running_joins_it() {
        let script = "console.log(JSON.stringify({event:'start'}));\nconsole.log(JSON.stringify({event:'progress',downloaded:50,total:100}));\nawait Bun.sleep(1000);\nconsole.log(JSON.stringify({event:'progress',downloaded:100,total:100}));\nconsole.log(JSON.stringify({event:'done',path:'/fake/chrome',source:'download'}));\n";
        with_fake_cli(script, || {
            JOB.reset();
            assert!(start().is_active());
            let mid = wait_for(&JOB, "downloading", |s| s.phase == "downloading");
            assert_eq!((mid.downloaded, mid.total), (Some(50), Some(100)));
            let generation = JOB.generation();
            assert!(start().is_active());
            assert_eq!(JOB.generation(), generation, "the running job was joined, not restarted");
            let done = wait_for(&JOB, "done", |s| s.phase == "done");
            assert_eq!(done.path.as_deref(), Some("/fake/chrome"));
            wait_for(&JOB, "reaped", |_| JOB.pid().is_none());
        });
    }

    #[test]
    fn an_error_event_and_an_unexpected_exit_are_failures() {
        with_fake_cli("console.log(JSON.stringify({event:'start'}));\nconsole.log(JSON.stringify({event:'error',message:'no network'}));\nprocess.exit(1);\n", || {
            JOB.reset();
            start();
            let s = wait_for(&JOB, "failed", |s| s.phase == "failed");
            assert_eq!(s.error.as_deref(), Some("no network"));
        });
        with_fake_cli("console.log(JSON.stringify({event:'start'}));\nprocess.exit(7);\n", || {
            JOB.reset();
            start();
            let s = wait_for(&JOB, "failed", |s| s.phase == "failed");
            assert!(s.error.unwrap().contains("stopped unexpectedly"));
        });
    }

    /// The fake CLI spawns a grandchild sleeper in the same tree and reports
    /// its pid; cancel must take the leader and the sleeper together —
    /// via the process group on unix, the Job Object on Windows.
    #[test]
    fn cancel_kills_the_whole_tree_and_stays_cancelled() {
        let pid_file = std::env::temp_dir().join(format!("openvids-sleeper-{}", std::process::id()));
        let _ = std::fs::remove_file(&pid_file);
        #[cfg(unix)]
        let spawn_line = "const s = spawn('sleep', ['60'], { stdio: 'ignore' });";
        #[cfg(windows)]
        let spawn_line = "const s = spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore' });";
        // `display()` on Windows yields backslashes, which are escapes inside
        // the JS single-quoted string below — double them first (no-op on unix).
        let pid_js = pid_file.display().to_string().replace('\\', "\\\\");
        let script = format!(
            "import {{ spawn }} from 'node:child_process';\nimport {{ writeFileSync }} from 'node:fs';\nconsole.log(JSON.stringify({{event:'start'}}));\n{spawn_line}\nwriteFileSync('{pid_js}', String(s.pid));\nconsole.log(JSON.stringify({{event:'progress',downloaded:1,total:9}}));\nawait new Promise(() => {{}});\n",
        );
        with_fake_cli(&script, || {
            JOB.reset();
            start();
            let pid = JOB.pid().expect("a running job has a pid");
            // The sleeper pid lands a breath after the progress line: the job
            // may report `downloading` before the fake CLI flushes the file.
            let sleeper: u32 = {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    if let Ok(text) = std::fs::read_to_string(&pid_file) {
                        if let Ok(pid) = text.trim().parse() {
                            break pid;
                        }
                    }
                    assert!(std::time::Instant::now() < deadline, "the fake CLI never reported its sleeper");
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            };
            assert!(process_alive(pid) && process_alive(sleeper));
            struct Sweep(u32, u32);
            impl Drop for Sweep {
                fn drop(&mut self) {
                    // Never leave a sleeper behind to lock files or block
                    // later builds: the job kill should have taken both.
                    crate::proc::kill_group_now(self.0);
                    crate::proc::kill_group_now(self.1);
                }
            }
            let _sweep = Sweep(pid, sleeper);
            assert_eq!(cancel().phase, "cancelled");
            wait_for(&JOB, "reaped", |_| JOB.pid().is_none());
            assert!(!process_alive(pid), "the leader is gone and reaped");
            wait_until_gone(sleeper);
            assert_eq!(state().phase, "cancelled");
            // Cancelling again, or with nothing running, changes nothing.
            assert_eq!(cancel().phase, "cancelled");
            JOB.reset();
        });
        let _ = std::fs::remove_file(&pid_file);
    }

    /// Unix-only: a child that traps and ignores SIGTERM must still die —
    /// cancel escalates to SIGKILL after the grace period. Windows has no
    /// signals, so the plain hanging tree dying on cancel is already covered
    /// by `cancel_kills_the_whole_tree_and_stays_cancelled`.
    #[cfg(unix)]
    #[test]
    fn cancel_escalates_to_sigkill_for_a_child_that_ignores_sigterm() {
        with_fake_cli(
            "process.on('SIGTERM', () => {});\nconsole.log(JSON.stringify({event:'start'}));\nawait new Promise(() => {});\n",
            || {
                JOB.reset();
                start();
                wait_for(&JOB, "checking", |s| s.phase == "checking");
                std::thread::sleep(Duration::from_millis(300));
                let pid = JOB.pid().unwrap();
                cancel();
                wait_for(&JOB, "killed after the grace period", |_| JOB.pid().is_none());
                assert!(!process_alive(pid));
            },
        );
    }

    #[test]
    fn a_missing_cli_is_a_failed_job_not_a_panic() {
        let _guard = crate::cli_runner::tests::FAKE_CLI_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("OPENVIDS_CLI_BUN", "/nonexistent/bun-does-not-exist");
        std::env::set_var(
            "OPENVIDS_CLI_ENTRY",
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"),
        );
        JOB.reset();
        let s = start();
        std::env::remove_var("OPENVIDS_CLI_BUN");
        std::env::remove_var("OPENVIDS_CLI_ENTRY");
        assert_eq!(s.phase, "failed");
        assert!(s.error.unwrap().contains("could not start"));
    }

    #[test]
    fn a_job_past_its_timeout_is_failed_and_killed() {
        static SHORT: InstallJob = InstallJob::new(&ChromeInstaller, Duration::from_millis(600));
        with_fake_cli("console.log(JSON.stringify({event:'start'}));\nawait new Promise(() => {});\n", || {
            SHORT.reset();
            SHORT.start();
            let pid = SHORT.pid().unwrap();
            let started = Instant::now();
            let s = wait_for(&SHORT, "timeout", |s| s.phase == "failed");
            assert!(s.error.unwrap().contains("longer than"));
            assert!(started.elapsed() < Duration::from_secs(10));
            wait_until_gone(pid);
        });
    }
}
