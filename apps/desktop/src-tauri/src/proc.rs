//! Every process the app owns, supervised as a whole tree.
//!
//! The Studio sidecar (`sidecar.rs`), the project-less agent runtime
//! (`agent_proxy.rs`), one-shot CLI runs and both installers (`cli_runner.rs`,
//! `install_job.rs`) all spawn through [`configure`] + [`track`] and tear down
//! through [`terminate`] / [`terminate_group`] / [`kill_group_now`], so
//! platform behavior cannot drift between owners.
//!
//! - Unix keeps exactly the historical behavior: the child gets its own
//!   process group (`process_group(0)`) and teardown signals the group
//!   (SIGTERM, a grace period, SIGKILL), then reaps the leader.
//! - Windows has neither process groups nor signals. Spawn sets
//!   `CREATE_NO_WINDOW` so no console window flashes, and the child is
//!   assigned to a Job Object limited with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`:
//!   quitting normally, crashing, or being killed from Task Manager closes the
//!   last job handle, and the OS then kills bun, Chrome and ffmpeg outright.
//!   There is no SIGTERM equivalent, so the "graceful" step is the job kill
//!   itself — `serve.mjs`'s SIGTERM handlers only run on unix. Chrome's
//!   half-written temp profiles are swept on next start (see `orphanBrowsers`).
//!
//! Spawn-then-assign race: the child runs unassigned between `spawn()` and
//! [`track`]. A suspended spawn + resume would close it, but the window is a
//! single `OpenProcess` + `AssignProcessToJobObject` before bun even maps its
//! DLLs, while the first grandchild (Chrome) only appears seconds later —
//! documented here instead of worked around.
//!
//! Job handles live in a pid-keyed registry for as long as the child is known;
//! [`terminate`] and [`kill_group_now`] remove the entry (closing the handle,
//! which itself kills any remainder), so killing is idempotent and a repeated
//! call is a harmless fallback. If the app dies without calling any of this,
//! the OS closes the handles and the trees die with it — that is the whole
//! point of `KILL_ON_JOB_CLOSE`.

use std::process::{Child, Command};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::collections::HashMap;
#[cfg(windows)]
use std::sync::{LazyLock, Mutex};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SET_QUOTA, PROCESS_TERMINATE, TerminateProcess,
};

/// How often a graceful shutdown polls for the leader's exit.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// What `GetExitCodeProcess` reports while the process is still running.
#[cfg(windows)]
const STILL_ACTIVE: u32 = 259;

/// Apply the platform's spawn flags to an owned child-to-be. Every owned
/// spawn (sidecar, agent runtime, CLI runs, installers) must call this before
/// `spawn()`, and [`track`] immediately after.
pub fn configure(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Assign an already-spawned child to a kill-on-close Job Object (Windows).
/// Best-effort: if the job cannot be created or the child is already gone,
/// teardown still kills and reaps the leader, just not its descendants.
/// No-op on unix, where group membership comes from [`configure`].
pub fn track(child: &Child) {
    #[cfg(windows)]
    {
        track_in_job(child);
    }
    #[cfg(not(windows))]
    {
        let _ = child;
    }
}

/// Stop a child's whole tree and reap the leader. Blocks up to `grace`
/// waiting for the leader after the first stop; always reaps. Idempotent:
/// calling it twice (or on an already-dead child) just reaps.
pub fn terminate(child: &mut Child, grace: Duration) {
    let pid = child.id();
    #[cfg(unix)]
    if pid > 0 {
        // SIGTERM first so the CLI runs its own shutdown (it closes Chrome
        // itself); the SIGKILL below is unconditional because the group can
        // outlive its leader, and on a dead group it is just ESRCH.
        unsafe { libc::killpg(pid as libc::pid_t, libc::SIGTERM) };
    }
    #[cfg(windows)]
    terminate_job_of(pid);
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    #[cfg(unix)]
    if pid > 0 {
        unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) };
    }
    // The job kill above stops the whole tree in the tracked case, but the
    // untracked case (assign raced the exit, job creation failed) still needs
    // the leader stopped directly. `Child::kill` on an exited child is a
    // harmless error, so this is unconditional.
    #[cfg(windows)]
    kill_pid(pid);
    let _ = child.kill();
    let _ = child.wait();
    #[cfg(windows)]
    forget_job(pid);
}

/// Ask a child's tree to stop without waiting; the caller escalates with
/// [`kill_group_now`]. On Windows there is no polite signal, so this is
/// already the job kill — the escalation then only closes the handle.
pub fn terminate_group(pid: u32) {
    #[cfg(unix)]
    if pid > 0 {
        unsafe { libc::killpg(pid as libc::pid_t, libc::SIGTERM) };
    }
    #[cfg(windows)]
    {
        terminate_job_of(pid);
        if !has_job(pid) {
            kill_pid(pid);
        }
    }
}

/// Forcibly stop a child's whole tree by pid. Idempotent and infallible:
/// unknown or already-dead pids are a no-op (plus a best-effort direct kill
/// for processes that never went through [`track`]).
pub fn kill_group_now(pid: u32) {
    #[cfg(unix)]
    if pid > 0 {
        unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) };
    }
    #[cfg(windows)]
    {
        terminate_job_of(pid);
        if !forget_job(pid) {
            kill_pid(pid);
        }
    }
}

/// Whether `pid` names a live process right now.
/// Only the tests and the install-job test-support call this today; the
/// production teardown never polls aliveness (it kills and reaps instead).
#[cfg_attr(not(test), expect(dead_code))]
pub fn is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
    #[cfg(windows)]
    {
        // SAFETY: the temporary handle is closed on the single path that opens it.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(process, &mut code);
            CloseHandle(process);
            // The OS reuses 259 for this, so a process that exited with code
            // 259 reads alive. No OpenVids child exits 259.
            ok != 0 && code == STILL_ACTIVE
        }
    }
}

#[cfg(windows)]
struct OwnedJob {
    handle: HANDLE,
}

// HANDLE is a raw pointer; the registry owns it and only touches it from
// behind its mutex.
// SAFETY: the handle is never copied out from behind the lock except as a
// value passed straight back to the OS.
#[cfg(windows)]
unsafe impl Send for OwnedJob {}
#[cfg(windows)]
unsafe impl Sync for OwnedJob {}

#[cfg(windows)]
impl Drop for OwnedJob {
    // Closing the last handle of a KILL_ON_JOB_CLOSE job kills the whole
    // tree — the hard-kill recovery this module exists for.
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

#[cfg(windows)]
#[allow(clippy::incompatible_msrv)]
static JOBS: LazyLock<Mutex<HashMap<u32, OwnedJob>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[cfg(windows)]
fn track_in_job(child: &Child) {
    let pid = child.id();
    if pid == 0 {
        return;
    }
    // SAFETY: every call below checks its return value and closes temporary
    // handles on every path; the job handle itself moves into the registry,
    // which closes it exactly once on removal or process exit.
    unsafe {
        if JOBS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&pid)
        {
            return;
        }
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if process.is_null() {
            return;
        }
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            CloseHandle(process);
            return;
        }
        // `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` derives `Default`, so this is
        // "no limits except the flags we set". The extended class is required:
        // on current Windows the basic class (2) rejects `SetInformation` with
        // `ERROR_INVALID_PARAMETER`, leaving a job with no `KILL_ON_JOB_CLOSE`
        // — `TerminateJobObject` would still work, but closing the handle
        // (normal quit, Task Manager kill) would orphan the tree.
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured == 0 {
            CloseHandle(job);
            CloseHandle(process);
            return;
        }
        if AssignProcessToJobObject(job, process) == 0 {
            CloseHandle(job);
            CloseHandle(process);
            return;
        }
        CloseHandle(process);
        JOBS.lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(pid, OwnedJob { handle: job });
    }
}

/// Best-effort whole-tree stop for a tracked pid. Unknown pids are a no-op.
#[cfg(windows)]
fn terminate_job_of(pid: u32) {
    let handle = JOBS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&pid)
        .map(|job| job.handle);
    if let Some(job) = handle {
        // SAFETY: the handle is live — the registry owns it until forget_job.
        unsafe {
            TerminateJobObject(job, 1);
        }
    }
}

/// Drop the job for `pid`, closing its handle. Returns whether one existed.
#[cfg(windows)]
fn forget_job(pid: u32) -> bool {
    JOBS.lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&pid)
        .is_some()
}

#[cfg(windows)]
fn has_job(pid: u32) -> bool {
    JOBS.lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(&pid)
}

/// Leader-only kill for a pid with no job (never tracked, or already
/// forgotten). Best-effort and idempotent.
#[cfg(windows)]
fn kill_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    // SAFETY: the temporary handle is closed on the single path that opens it.
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !process.is_null() {
            TerminateProcess(process, 1);
            CloseHandle(process);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    /// A pid that is definitely dead: spawn something trivial and reap it.
    /// (A hardcoded large pid could be alive; a reaped child cannot be reused
    /// before this returns in practice.)
    fn dead_pid() -> u32 {
        #[cfg(unix)]
        let mut child = Command::new("true").spawn().expect("true spawns");
        #[cfg(windows)]
        let mut child = Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .expect("cmd spawns");
        let pid = child.id();
        let _ = child.wait();
        pid
    }

    #[test]
    fn aliveness_follows_the_process() {
        assert!(is_alive(std::process::id()));
        assert!(!is_alive(dead_pid()));
        assert!(!is_alive(0));
    }

    #[cfg(windows)]
    const TREE_PARENT_JS: &str = r#"
import { spawn } from 'node:child_process';
const grandchild = spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore' });
process.stdout.write(`GRANDCHILD ${grandchild.pid}\n`);
await new Promise(() => {});
"#;

    #[cfg(windows)]
    struct Tree {
        child: Child,
        parent_pid: u32,
        grandchild_pid: u32,
        dir: std::path::PathBuf,
    }

    /// The `Child` plus every pid the test created: dropping the guard kills
    /// the whole tree even when an assertion fires first, so a failing test
    /// can never orphan a `bun` that locks `target/debug/bun.exe` (and with
    /// it, every later build — `os error 32`).
    #[cfg(windows)]
    struct TreeGuard {
        tree: Option<Tree>,
    }

    #[cfg(windows)]
    impl TreeGuard {
        fn tree(&mut self) -> &mut Tree {
            self.tree.as_mut().expect("test tree is alive")
        }
    }

    #[cfg(windows)]
    impl Drop for TreeGuard {
        fn drop(&mut self) {
            if let Some(mut tree) = self.tree.take() {
                // The job kill is the real assertion; these are the backstop.
                terminate_job_of(tree.parent_pid);
                kill_pid(tree.grandchild_pid);
                kill_pid(tree.parent_pid);
                let _ = tree.child.kill();
                let _ = tree.child.wait();
                let _ = std::fs::remove_dir_all(&tree.dir);
            }
        }
    }

    /// Parent (`bun parent.mjs`) spawns a grandchild (`ping -n 60`) and naps
    /// forever; both go through the proc layer like the real sidecar does.
    /// The runtime is a copy beside the script, never `target/debug/bun.exe`.
    #[cfg(windows)]
    fn spawn_tree(tag: &str) -> TreeGuard {
        let dir = std::env::temp_dir().join(format!(
            "openvids-proc-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("parent.mjs"), TREE_PARENT_JS).expect("parent script");
        let bun_copy = dir.join(crate::platform::BUN_BIN);
        let bun_src = crate::cli_runner::tests::find_bun_for_tests();
        std::fs::copy(&bun_src, &bun_copy).expect("copy bun for the test tree");
        let mut command = Command::new(&bun_copy);
        command
            .arg(dir.join("parent.mjs"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        configure(&mut command);
        let mut child = command.spawn().expect("bun spawns the tree parent");
        track(&child);
        let parent_pid = child.id();
        let stdout = child.stdout.take().expect("piped stdout");
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .expect("the parent reports its grandchild");
        let grandchild_pid: u32 = line
            .trim()
            .strip_prefix("GRANDCHILD ")
            .expect("grandchild report")
            .parse()
            .expect("grandchild pid");
        assert!(is_alive(parent_pid), "the parent is running");
        assert!(is_alive(grandchild_pid), "the grandchild is running");
        TreeGuard {
            tree: Some(Tree {
                child,
                parent_pid,
                grandchild_pid,
                dir,
            }),
        }
    }

    #[cfg(windows)]
    fn wait_until_gone(pid: u32) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while is_alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!is_alive(pid), "process {pid} is still alive");
    }

    #[cfg(windows)]
    #[test]
    fn terminate_kills_the_whole_tree() {
        let mut guard = spawn_tree("terminate");
        let tree = guard.tree();
        let (parent_pid, grandchild_pid) = (tree.parent_pid, tree.grandchild_pid);
        terminate(&mut tree.child, Duration::from_secs(10));
        wait_until_gone(grandchild_pid);
        assert!(!is_alive(parent_pid), "the parent is gone too");
        // Idempotent: a second call just reaps.
        terminate(&mut guard.tree().child, Duration::from_secs(1));
    }

    #[cfg(windows)]
    #[test]
    fn closing_the_job_kills_the_tree() {
        // What a hard kill of the owner does: every handle closes, and
        // KILL_ON_JOB_CLOSE reaps the tree without anyone calling terminate.
        let mut guard = spawn_tree("close");
        let (parent_pid, grandchild_pid) = {
            let tree = guard.tree();
            (tree.parent_pid, tree.grandchild_pid)
        };
        assert!(forget_job(parent_pid), "the tree is tracked");
        wait_until_gone(parent_pid);
        wait_until_gone(grandchild_pid);
        let _ = guard.tree().child.wait();
    }

    /// A helper process owns a kill-on-close job holding a `ping` tree, then
    /// is hard-killed with `taskkill /F` (no cleanup runs in the victim).
    /// The helper links no workspace code: it re-declares the two job calls
    /// with the extended-limit class the OS accepts (see `track_in_job`).
    #[cfg(windows)]
    const JOB_HOLDER_RS: &str = r#"
 use std::os::raw::c_void;

type Handle = *mut c_void;

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, len: u32) -> i32;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn CloseHandle(handle: Handle) -> i32;
}

#[repr(C)]
struct Basic {
    t1: i64,
    t2: i64,
    flags: u32,
    min_ws: usize,
    max_ws: usize,
    active: u32,
    affinity: usize,
    priority: u32,
    scheduling: u32,
}

#[repr(C)]
struct Extended {
    basic: Basic,
    io0: u64,
    io1: u64,
    io2: u64,
    io3: u64,
    io4: u64,
    io5: u64,
    proc_mem: usize,
    job_mem: usize,
    peak_proc: usize,
    peak_job: usize,
}

fn main() {
    let child = std::process::Command::new("ping")
        .args(["-n", "120", "127.0.0.1"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("ping spawns");
    println!("HOLDERCHILD {}", child.id());
    use std::io::Write as _;
    std::io::stdout().flush().expect("flush");
    unsafe {
        let process = OpenProcess(0x100 | 0x1, 0, child.id());
        assert!(!process.is_null());
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null() as *const u16);
        assert!(!job.is_null());
        // Extended class (9): the basic class (2) is rejected with
        // ERROR_INVALID_PARAMETER on current Windows (see `track_in_job`).
        let mut info: Extended = std::mem::zeroed();
        info.basic.flags = 0x2000;
        assert_ne!(
            SetInformationJobObject(
                job,
                9,
                &info as *const _ as *const c_void,
                std::mem::size_of::<Extended>() as u32
            ),
            0
        );
        assert_ne!(AssignProcessToJobObject(job, process), 0);
        CloseHandle(process);
        // Hold the job open until the test kills us; the OS then kills ping.
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }
}
"#;

    #[cfg(windows)]
    #[test]
    fn owner_hard_kill_kills_the_tree() {
        let dir = std::env::temp_dir().join(format!(
            "openvids-proc-holder-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("jobholder.rs"), JOB_HOLDER_RS).expect("helper source");
        let compile = Command::new("rustc")
            .arg("--edition=2021")
            .arg("jobholder.rs")
            .arg("-o")
            .arg("jobholder.exe")
            .current_dir(&dir)
            .output()
            .expect("rustc runs");
        assert!(
            compile.status.success(),
            "the helper did not compile: {}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let mut holder = Command::new(dir.join("jobholder.exe"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("the holder spawns");
        // Deliberately NOT tracked: the helper owns its own job, like the app
        // owns its sidecars' jobs.
        let holder_pid = holder.id();
        let stdout = holder.stdout.take().expect("piped stdout");
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .expect("the holder reports its child");
        let ping_pid: u32 = line
            .trim()
            .strip_prefix("HOLDERCHILD ")
            .expect("holder report")
            .parse()
            .expect("holder child pid");
        assert!(is_alive(ping_pid), "the holder's child is running");
        // No /T: taskkill must kill only the holder; the job does the rest.
        let killed = Command::new("taskkill")
            .args(["/F", "/PID", &holder_pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("taskkill runs");
        assert!(
            killed.status.success(),
            "taskkill killed the holder: {} {}",
            String::from_utf8_lossy(&killed.stdout),
            String::from_utf8_lossy(&killed.stderr),
        );
        let _ = holder.wait();
        wait_until_gone(ping_pid);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The production stack has one more layer: the app spawns
    /// `bun serve.mjs <cli> …`, and `serve.mjs` spawns `bun <cli>` with
    /// `windowsHide`. The launcher must not break job containment — the
    /// whole tree still dies with the job, like the production sidecar.
    #[cfg(windows)]
    #[test]
    fn job_kill_reaches_through_the_serve_launcher() {
        let dir = std::env::temp_dir().join(format!(
            "openvids-proc-serve-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let pid_file = dir.join("ping.pid");
        std::fs::write(
            dir.join("cli.mjs"),
            format!(
                "import {{ spawn }} from 'node:child_process';\nimport {{ writeFileSync }} from 'node:fs';\nconst p = spawn('ping', ['-n', '60', '127.0.0.1'], {{ stdio: 'ignore' }});\nwriteFileSync('{}', String(p.pid));\nawait new Promise(() => {{}});\n",
                pid_file.display().to_string().replace('\\', "\\\\"),
            ),
        )
        .expect("fake cli");
        let serve = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("sidecar")
            .join("serve.mjs");
        assert!(serve.is_file(), "the real launcher exists");
        let bun_copy = dir.join(crate::platform::BUN_BIN);
        std::fs::copy(crate::cli_runner::tests::find_bun_for_tests(), &bun_copy)
            .expect("copy bun for the launcher tree");
        let mut command = Command::new(&bun_copy);
        command
            .arg(&serve)
            .arg(dir.join("cli.mjs"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure(&mut command);
        let child = command.spawn().expect("the launcher spawns");
        track(&child);
        let launcher_pid = child.id();
        // Guard: never orphan the launcher tree on assertion failure.
        struct Sweep {
            child: Child,
            pids: Vec<u32>,
            dir: std::path::PathBuf,
        }
        impl Drop for Sweep {
            fn drop(&mut self) {
                terminate_job_of(self.child.id());
                for pid in &self.pids {
                    kill_pid(*pid);
                }
                kill_pid(self.child.id());
                let _ = self.child.kill();
                let _ = self.child.wait();
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }
        let mut sweep = Sweep {
            child,
            pids: vec![launcher_pid],
            dir: dir.clone(),
        };
        let ping: u32 = {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Ok(text) = std::fs::read_to_string(&pid_file) {
                    if let Ok(pid) = text.trim().parse() {
                        break pid;
                    }
                }
                assert!(Instant::now() < deadline, "the fake CLI never reported ping");
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        sweep.pids.push(ping);
        assert!(is_alive(launcher_pid) && is_alive(ping), "launcher tree is running");
        terminate(&mut sweep.child, Duration::from_secs(10));
        wait_until_gone(ping);
        assert!(!is_alive(launcher_pid), "the launcher is gone too");
    }
}
