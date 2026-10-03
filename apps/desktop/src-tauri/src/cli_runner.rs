//! One-shot runs of the bundled HyperFrames CLI, for the first-run System check
//! and the Chrome installer. The Studio sidecar (`sidecar.rs`) runs the same CLI
//! as a long-lived `preview` server; this is the short-lived sibling and reuses
//! the same pieces:
//!
//! - production: `bun serve.mjs hyperframes/cli.js <args>` from the app's
//!   resources (`set_production_launch`, called once from `lib.rs`). `serve.mjs`
//!   is the launcher that kills its child when OpenVids dies without cleaning
//!   up (SIGKILL, crash), so a download never outlives the app;
//! - development: `bun apps/desktop/sidecar/serve.mjs packages/cli/src/cli.ts`
//!   in the workspace (bun runs the TypeScript entry directly);
//! - `OPENVIDS_CLI_BUN` / `OPENVIDS_CLI_ENTRY` override both (tests point them
//!   at a shell script).
//!
//! Every child gets its own supervision scope (process group on unix, Job
//! Object on Windows — see `crate::proc`); `kill_group` stops the whole tree
//! and always reaps the leader, so a cancelled or timed-out run leaves
//! neither a zombie nor an orphaned Chrome.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::json;

use super::coded_error::CodedError;

/// How long a child gets between SIGTERM and SIGKILL.
pub const TERM_GRACE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone)]
pub struct CliLaunch {
    pub bun: PathBuf,
    /// Extra argv between the runtime and the launcher/entry. Test-only:
    /// `cmd /C <entry.cmd>` needs its `/C` back after the entry on Windows.
    /// Production never sets `OPENVIDS_CLI_BUN_ARGS`, so this stays empty.
    pub bun_args: Vec<String>,
    /// `serve.mjs`, when there is one: it ties the child's life to ours.
    pub launcher: Option<PathBuf>,
    pub entry: PathBuf,
}

static PROD_LAUNCH: Mutex<Option<CliLaunch>> = Mutex::new(None);

/// Production: the staged runtime's bun, launcher and `hyperframes/cli.js`.
pub fn set_production_launch(bun: PathBuf, launcher: PathBuf, entry: PathBuf) {
    if let Ok(mut slot) = PROD_LAUNCH.lock() {
        *slot = Some(CliLaunch {
            bun,
            bun_args: Vec::new(),
            launcher: Some(launcher),
            entry,
        });
    }
}

/// Env overrides, else the staged production CLI, else the workspace (dev).
pub fn launch() -> Option<CliLaunch> {
    let bun_override = std::env::var_os("OPENVIDS_CLI_BUN").map(PathBuf::from);
    // Test-only (see `CliLaunch::bun_args`): split on whitespace, no quoting.
    let bun_args: Vec<String> = std::env::var("OPENVIDS_CLI_BUN_ARGS")
        .map(|args| args.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default();
    if let Some(entry) = std::env::var_os("OPENVIDS_CLI_ENTRY").map(PathBuf::from) {
        if entry.is_absolute() && entry.is_file() {
            return Some(CliLaunch {
                bun: bun_override.unwrap_or_else(|| PathBuf::from(crate::platform::BUN_BIN)),
                bun_args,
                launcher: None,
                entry,
            });
        }
    }
    if let Some(prod) = PROD_LAUNCH.lock().ok().and_then(|s| s.clone()) {
        if prod.entry.is_file() {
            return Some(CliLaunch {
                bun: bun_override.unwrap_or(prod.bun),
                bun_args,
                ..prod
            });
        }
    }
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..");
    let entry = workspace.join("packages").join("cli").join("src").join("cli.ts");
    let launcher = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("sidecar")
        .join("serve.mjs");
    if entry.is_file() {
        return Some(CliLaunch {
            bun: bun_override.unwrap_or_else(|| PathBuf::from(crate::platform::BUN_BIN)),
            bun_args: Vec::new(),
            launcher: launcher.is_file().then_some(launcher),
            entry,
        });
    }
    None
}

/// The command for `hyperframes <args>`, not yet spawned: stdout piped, stdin
/// closed, own supervision scope (see `crate::proc`).
pub fn command(args: &[&str]) -> Result<Command, CodedError> {
    let launch = launch().ok_or_else(|| {
        CodedError::plain("cli_not_installed", "the OpenVids command-line tools are not installed")
    })?;
    let mut command = Command::new(&launch.bun);
    command.args(&launch.bun_args);
    if let Some(launcher) = &launch.launcher {
        command.arg(launcher);
    }
    command
        .arg(&launch.entry)
        .args(args)
        .current_dir(launch.entry.parent().unwrap_or_else(|| std::path::Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (key, value) in super::ffmpeg_install::managed_env() {
        command.env(key, value);
    }
    crate::proc::configure(&mut command);
    Ok(command)
}

/// Signal the child's whole tree, give it `TERM_GRACE`, then SIGKILL
/// the tree, and reap the leader. Blocks up to the grace period.
pub fn kill_group(child: &mut Child) {
    crate::proc::terminate(child, TERM_GRACE);
}

/// Ask a child's tree to stop without waiting (the caller escalates).
pub fn terminate_group(pid: u32) {
    crate::proc::terminate_group(pid);
}

/// Forcibly stop a child's whole tree.
pub fn kill_group_now(pid: u32) {
    crate::proc::kill_group_now(pid);
}

/// Run `hyperframes <args>` to completion and return its stdout. A run that
/// takes longer than `timeout` is killed (tree included) and fails.
pub fn run(args: &[&str], timeout: Duration) -> Result<String, CodedError> {
    let mut child = command(args)?.spawn().map_err(|e| {
        CodedError::new(
            "cli_start_failed",
            format!("could not start the OpenVids command-line tools: {e}"),
            json!({ "detail": e.to_string() }),
        )
    })?;
    crate::proc::track(&child);
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| CodedError::plain("cli_no_stdout", "no stdout"))?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.by_ref().take(1024 * 1024).read_to_string(&mut out);
        out
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                kill_group(&mut child);
                // The pipe's read end lives on the reader thread: joining it
                // waits for every inheritor of stdout to exit. `kill_group`
                // reaps the leader but a straggler outside the job (or a
                // wedged pipe) must not hold this thread past the grace
                // period — the 10 s test bound measures exactly this.
                // Detach: the reader owns `stdout` now and dies with it;
                // `run` returns without waiting for the pipe to drain.
                return Err(CodedError::plain("check_timeout", "the check took too long"));
            }
            Err(e) => {
                kill_group(&mut child);
                let _ = reader.join();
                return Err(CodedError::new(
                    "check_wait_failed",
                    format!("could not wait for the check: {e}"),
                    json!({ "detail": e.to_string() }),
                ));
            }
        }
    };
    // The leader is gone; a straggler in its group must not keep the pipe open.
    kill_group_now(child.id());
    let out = reader.join().unwrap_or_default();
    if !status.success() {
        return Err(CodedError::new(
            "check_failed",
            format!("the check failed ({status})"),
            json!({ "status": status.to_string() }),
        ));
    }
    Ok(out)
}

/// The last line of `output` that is a JSON object (the CLI may print notices first).
pub fn last_json_line(output: &str) -> Option<serde_json::Value> {
    output
        .lines()
        .rev()
        .map(str::trim)
        .filter(|l| l.starts_with('{'))
        .find_map(|l| serde_json::from_str(l).ok())
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A fake CLI entry: a script run by `bun` (same launcher the real CLI
    /// uses in dev). Batch/`.cmd` cannot express what the tests need —
    /// JSON with braces/quotes, background children, pid reporting, argv
    /// branching — and `wmic` (pid lookup) is gone from Win11, while `bun`
    /// is always on PATH in this repo's dev/test environment. Env vars are
    /// process-wide, so tests that use it hold this lock.
    pub static FAKE_CLI_LOCK: Mutex<()> = Mutex::new(());

    const FAKE_ENTRY_SUFFIX: &str = "cli.mjs";

    pub fn with_fake_cli<T>(script: &str, body: impl FnOnce() -> T) -> T {
        let _guard = FAKE_CLI_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "openvids-fake-cli-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let entry = dir.join(FAKE_ENTRY_SUFFIX);
        std::fs::write(&entry, script).unwrap();
        // Copy the runtime next to the script: the child then runs from a
        // path no build step ever locks or replaces (the cargo `target/`
        // copy is overwritten by `stage-runtime`, and an in-use `bun.exe`
        // there blocks linking with `os error 32`).
        let bun_src = find_bun_for_tests();
        let bun_copy = dir.join(crate::platform::BUN_BIN);
        let bun_ok = std::fs::copy(&bun_src, &bun_copy).is_ok();
        let bun_cmd = if bun_ok { bun_copy } else { bun_src };
        std::env::set_var("OPENVIDS_CLI_BUN", &bun_cmd);
        std::env::set_var("OPENVIDS_CLI_ENTRY", &entry);
        let out = body();
        std::env::remove_var("OPENVIDS_CLI_BUN");
        std::env::remove_var("OPENVIDS_CLI_BUN_ARGS");
        std::env::remove_var("OPENVIDS_CLI_ENTRY");
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    /// `BUN_BIN` is a bare file name in dev: search PATH the way the OS
    /// would, so the fake CLI never depends on the runner's cwd.
    /// `OPENVIDS_TEST_BUN` overrides the search (power users, packaging).
    /// `pub(crate)` for the `proc` tree tests, which copy the runtime for
    /// the same reason `with_fake_cli` does.
    pub(crate) fn find_bun_for_tests() -> std::path::PathBuf {
        if let Some(path) = std::env::var_os("OPENVIDS_TEST_BUN") {
            return std::path::PathBuf::from(path);
        }
        let path = std::env::var_os("PATH").unwrap_or_default();
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(crate::platform::BUN_BIN);
            if candidate.is_file() {
                return candidate;
            }
        }
        std::path::PathBuf::from(crate::platform::BUN_BIN)
    }

    /// `echo {"args":"$*"}` in the shell at hand.
    const ECHO_ARGS_SCRIPT: &str =
        "console.log(JSON.stringify({args: process.argv.slice(2).join(' ')}));";

    /// `exit 3` in the shell at hand.
    const EXIT_3_SCRIPT: &str = "process.exit(3);";

    /// A script that outlives `timeout` while holding a same-tree child.
    /// The child is a real grandchild process (not a thread): on unix two
    /// `sleep`s, on Windows a `ping` sleeper — both must die with the tree.
    #[cfg(unix)]
    const HANG_WITH_CHILD_SCRIPT: &str =
        "import { spawn } from 'node:child_process';\nspawn('sleep', ['30'], { stdio: 'ignore' });\nspawn('sleep', ['30'], { stdio: 'ignore' });\nawait new Promise(() => {});\n";
    #[cfg(windows)]
    const HANG_WITH_CHILD_SCRIPT: &str =
        "import { spawn } from 'node:child_process';\nspawn('ping', ['-n', '30', '127.0.0.1'], { stdio: 'ignore' });\nawait new Promise(() => {});\n";

    #[test]
    fn json_is_taken_from_the_last_object_line() {
        let out = "notice\n{\"a\":1}\nmore\n{\"b\":2}\n";
        assert_eq!(last_json_line(out).unwrap()["b"], 2);
        assert!(last_json_line("nothing here").is_none());
    }

    #[test]
    fn a_run_returns_stdout_and_passes_its_arguments() {
        let out = with_fake_cli(ECHO_ARGS_SCRIPT, || {
            run(&["doctor", "--tools"], Duration::from_secs(5))
        })
        .unwrap();
        assert_eq!(last_json_line(&out).unwrap()["args"], "doctor --tools");
    }

    #[test]
    fn a_failing_run_is_an_error() {
        let err = with_fake_cli(EXIT_3_SCRIPT, || run(&["x"], Duration::from_secs(5))).unwrap_err();
        assert!(err.message.contains("failed"), "{err}");
        assert_eq!(err.code, Some("check_failed"));
    }

    #[test]
    fn a_run_past_its_timeout_is_killed_with_its_children() {
        let started = std::time::Instant::now();
        // The script spawns a child sleeper in the same tree; both must go.
        let err = with_fake_cli(HANG_WITH_CHILD_SCRIPT, || {
            run(&["x"], Duration::from_millis(300))
        })
        .unwrap_err();
        assert!(err.message.contains("too long"), "{err}");
        assert_eq!(err.code, Some("check_timeout"));
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
