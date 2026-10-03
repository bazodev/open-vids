//! The "Install FFmpeg" button: macOS runs `brew install ffmpeg` (the formula
//! provides `ffprobe` too); Windows downloads the official release-essentials
//! build into `~/.openvids/ffmpeg` and points every child process at it.
//! Download happens only after an explicit click, never on its own.
//!
//! How brew is run, deliberately:
//!
//! - directly (absolute path, argument array, no shell), in its own session
//!   (`setsid`): no controlling terminal, so nothing can open `/dev/tty` to ask
//!   for a password, and stdin is closed. With `NONINTERACTIVE=1` brew fails
//!   instead of prompting; a failure that smells like "needs sudo / a terminal"
//!   is reported as "run it in Terminal".
//! - a sane environment for a GUI-launched app: PATH with brew's own bin and
//!   sbin first, HOME and the user's `HOMEBREW_*`/proxy settings inherited,
//!   `HOMEBREW_NO_ENV_HINTS`, `HOMEBREW_NO_ANALYTICS`, no colour, no emoji.
//! - **auto-update policy**: the first run sets `HOMEBREW_NO_AUTO_UPDATE=1`,
//!   the second (only after a failure that looks like stale formula metadata:
//!   "No available formula", a 404, a failed download or a checksum mismatch)
//!   lets brew update itself first. Skipping the update makes the usual install
//!   much faster and keeps it from touching anything but ffmpeg and its missing
//!   dependencies; the retry covers a very stale Homebrew without making every
//!   user pay for an update. `HOMEBREW_NO_INSTALL_UPGRADE` and
//!   `HOMEBREW_NO_INSTALL_CLEANUP` keep it from upgrading or cleaning up the
//!   user's other packages as a side effect.
//! - a cancelled, failed or timed-out install is left to Homebrew's own cleanup:
//!   OpenVids deletes none of brew's files.
//!
//! brew prints no byte progress, so the state carries `detail`, the current
//! (sanitised, one-line, bounded) line of its output.
//!
//! Homebrew is looked for in `$OPENVIDS_BREW_PATH` (tests), `/opt/homebrew/bin/brew`
//! (Apple Silicon), `/usr/local/bin/brew` (Intel), then PATH, on macOS only.
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};
use std::time::Duration;

use serde_json::json;
use sha2::{Digest, Sha256};

use super::cli_runner;
use super::coded_error::CodedError;
use super::install_job::{one_line, ExitAction, InstallJob, InstallState, Installer, Stream};
use super::prefs;

/// What the UI says before and while this runs.
pub const INSTALL_COMMAND: &str = "brew install ffmpeg";
pub const INSTALL_NOTE: &str =
    "Runs `brew install ffmpeg`. It may install many dependency packages and take several minutes.";

/// The single build Windows downloads: release essentials, linked from
/// ffmpeg.org's download page. It carries every codec the renderer needs
/// (libx264/libx265, libvpx-vp9, libaom, libmp3lame, libopus, libvorbis,
/// native AAC, prores_ks) and the zscale+tonemap filters for HDR work.
pub const WINDOWS_BUILD_VERSION: &str = "9.0.2";
pub const WINDOWS_BUILD_URL: &str =
    "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip";
/// The checksum file published next to the build.
pub const WINDOWS_BUILD_SHA256_URL: &str =
    "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip.sha256";
/// Hosts a download may come from: the fixed https allow-list.
pub const WINDOWS_BUILD_HOSTS: &[&str] = &["www.gyan.dev"];
pub const BREW_URL: &str = "https://brew.sh";
const DETAIL_CHARS: usize = 160;
const REASON_CHARS: usize = 220;

/// The brew executable, if Homebrew is installed.
pub fn find_brew() -> Option<PathBuf> {
    if let Some(over) = std::env::var_os("OPENVIDS_BREW_PATH").filter(|v| !v.is_empty()) {
        let path = PathBuf::from(over);
        return path.is_file().then_some(path);
    }
    if !cfg!(target_os = "macos") {
        return None;
    }
    ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
        .iter()
        .map(PathBuf::from)
        .chain(
            std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).map(|d| d.join("brew")).collect::<Vec<_>>())
                .unwrap_or_default(),
        )
        .find(|p| p.is_file())
}

/// One printable line out of a raw line of brew output: ANSI escapes and control
/// characters gone, only the last `\r` segment (progress bars redraw one line),
/// the `==>` marker dropped, whitespace collapsed, bounded. `None` for lines
/// with no words in them (`#####  42.0%`, blank lines).
pub fn sanitize_line(raw: &str) -> Option<String> {
    let last = raw.rsplit('\r').find(|s| !s.trim().is_empty()).unwrap_or("");
    let mut text = String::with_capacity(last.len());
    let mut chars = last.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI: ESC [ params final-byte (0x40-0x7E); anything else after ESC is dropped with it.
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            } else {
                chars.next();
            }
        } else if !c.is_control() {
            text.push(c);
        } else if c == '\t' {
            text.push(' ');
        }
    }
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let line = collapsed.strip_prefix("==>").unwrap_or(&collapsed).trim();
    if !line.chars().any(char::is_alphabetic) {
        return None;
    }
    Some(line.chars().take(DETAIL_CHARS).collect())
}

/// Failure text that means "this needs an administrator or a terminal".
fn needs_terminal(text: &str) -> bool {
    let lower = text.to_lowercase();
    ["sudo", "password", "terminal is required", "no tty", "interactive", "administrator"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// Failure text that looks like stale formula metadata, worth one retry with an update.
fn looks_stale(text: &str) -> bool {
    let lower = text.to_lowercase();
    ["no available formula", "404", "failed to download", "sha256 mismatch", "checksum"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// The one-line reason for a failed run from the stderr tail. Brew's own line has no code: it is not our text.
pub fn failure_reason(tail: &[String], status: &ExitStatus) -> CodedError {
    let joined = tail.join("\n");
    if needs_terminal(&joined) {
        return CodedError::new(
            "brew_needs_terminal",
            format!("Homebrew needs administrator access or a Terminal. Run `{INSTALL_COMMAND}` in Terminal."),
            json!({ "command": INSTALL_COMMAND }),
        );
    }
    let lines: Vec<String> = tail.iter().filter_map(|l| sanitize_line(l)).collect();
    let reason = lines
        .iter()
        .rev()
        .find(|l| l.starts_with("Error:"))
        .or_else(|| lines.last());
    match reason {
        Some(line) => CodedError::uncoded(one_line(line, REASON_CHARS)),
        None => CodedError::new(
            "brew_failed",
            format!("`{INSTALL_COMMAND}` failed ({status})"),
            json!({ "command": INSTALL_COMMAND, "status": status.to_string() }),
        ),
    }
}

/// Homebrew is not installed: where to get it and what to run afterwards.
pub fn homebrew_missing() -> CodedError {
    CodedError::new(
        "homebrew_missing",
        format!("Homebrew was not found. Install it from {BREW_URL}, then run `{INSTALL_COMMAND}`."),
        json!({ "url": BREW_URL, "command": INSTALL_COMMAND }),
    )
}

struct BrewInstaller;

impl BrewInstaller {
    fn environment(brew: &Path, attempt: u32) -> Vec<(String, String)> {
        let bin = brew.parent().unwrap_or_else(|| Path::new("/usr/bin"));
        let sbin = bin.parent().map(|p| p.join("sbin")).unwrap_or_else(|| bin.to_path_buf());
        let inherited = std::env::var("PATH").unwrap_or_default();
        let path = format!(
            "{}:{}:/usr/bin:/bin:/usr/sbin:/sbin{}{}",
            bin.display(),
            sbin.display(),
            if inherited.is_empty() { "" } else { ":" },
            inherited
        );
        let mut env = vec![
            ("PATH", path.as_str()),
            ("NONINTERACTIVE", "1"),
            ("HOMEBREW_NO_ENV_HINTS", "1"),
            ("HOMEBREW_NO_ANALYTICS", "1"),
            ("HOMEBREW_NO_INSTALL_UPGRADE", "1"),
            ("HOMEBREW_NO_INSTALL_CLEANUP", "1"),
            ("HOMEBREW_NO_EMOJI", "1"),
            ("HOMEBREW_NO_COLOR", "1"),
            ("NO_COLOR", "1"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect::<Vec<_>>();
        if attempt == 0 {
            env.push(("HOMEBREW_NO_AUTO_UPDATE".into(), "1".into()));
        }
        env
    }
}

impl Installer for BrewInstaller {
    fn command(&self, attempt: u32) -> Result<Command, CodedError> {
        let brew = find_brew().ok_or_else(homebrew_missing)?;
        // Tests point `OPENVIDS_BREW_PATH` at a `.mjs` script: run it on the
        // same runtime the fake CLI uses, with the brew path as argv[1].
        // A real brew stays a direct spawn with no shell in between.
        let mut command = if brew.extension().and_then(|e| e.to_str()) == Some("mjs") {
            let mut fake = Command::new(crate::platform::BUN_BIN);
            fake.arg(&brew);
            fake
        } else {
            Command::new(&brew)
        };
        command.args(["install", "ffmpeg"]);
        for (key, value) in Self::environment(&brew, attempt) {
            command.env(key, value);
        }
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // SAFETY: setsid is async-signal-safe and the only call in the hook.
            // A new session is its own process group (killpg works on it) and has
            // no controlling terminal, so nothing can prompt on /dev/tty.
            unsafe {
                command.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        }
        Ok(command)
    }

    fn started(&self) -> InstallState {
        let mut state = InstallState::of("installing");
        state.detail = Some("Starting Homebrew".into());
        state
    }

    fn on_line(&self, state: &mut InstallState, _stream: Stream, line: &str) {
        if let Some(detail) = sanitize_line(line) {
            state.detail = Some(detail);
        }
    }

    fn on_exit(
        &self,
        state: &mut InstallState,
        status: &ExitStatus,
        stderr_tail: &[String],
        attempt: u32,
    ) -> ExitAction {
        if status.success() {
            return ExitAction::Verify;
        }
        if attempt == 0 && looks_stale(&stderr_tail.join("\n")) {
            state.detail = Some("Updating Homebrew and trying again".into());
            return ExitAction::Retry;
        }
        *state = InstallState::failed_with(&failure_reason(stderr_tail, status));
        ExitAction::Finished
    }

    /// brew said it worked: the tools must now be findable (a fresh CLI process
    /// looks, so the page's next System check sees them too).
    fn verify(&self) -> Result<Option<String>, CodedError> {
        let Ok(out) = cli_runner::run(&["doctor", "--tools"], Duration::from_secs(10)) else {
            // No CLI to ask: Homebrew's success is all there is.
            return Ok(None);
        };
        let Some(tools) = cli_runner::last_json_line(&out).and_then(|v| v.get("tools").cloned()) else {
            return Ok(None);
        };
        let found = |name: &str| tools.get(name).and_then(|t| t.get("found")).and_then(|f| f.as_bool()) == Some(true);
        if !found("ffmpeg") {
            return Err(CodedError::plain(
                "ffmpeg_not_found_after",
                "Homebrew finished, but ffmpeg was not found afterwards.",
            ));
        }
        Ok(tools
            .get("ffmpeg")
            .and_then(|t| t.get("path"))
            .and_then(|p| p.as_str())
            .map(str::to_string))
    }
}

/// The Windows half: download the official release-essentials build into
/// `~/.openvids/ffmpeg`, verified against the publisher's SHA-256. Driven
/// in-process by a worker thread (there is no child to supervise), with byte
/// progress in the state like the Chrome installer.
struct DownloadInstaller;

/// State for one active download: the job it reports to, the generation it
/// must still own when it finishes, its byte progress, and the flag cancel
/// flips to stop the fetch loops.
struct DownloadRun {
    job: &'static InstallJob,
    generation: u64,
    progress: std::sync::Arc<DownloadProgress>,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl DownloadInstaller {
    /// Run the blocking download on a worker, then land the outcome in the
    /// slot when this generation still owns it. A cancelled or superseded
    /// run leaves the slot alone.
    fn run(run: DownloadRun) {
        let outcome = download_and_install(&run.progress, &run.cancelled);
        run.job.with_slot(|slot| {
            if slot.generation != run.generation || !slot.state.is_active() {
                return;
            }
            slot.pid = None;
            slot.state = match outcome {
                Ok(path) => {
                    let mut done = InstallState::of("done");
                    done.path = Some(path);
                    done
                }
                Err(error) if error.code == Some("ffmpeg_cancelled") => InstallState::of("cancelled"),
                Err(error) => InstallState::failed_with(&error),
            };
        });
    }
}

impl Installer for DownloadInstaller {
    fn command(&self, _attempt: u32) -> Result<Command, CodedError> {
        // `InstallJob::spawn` is bypassed below; this must never run.
        Err(CodedError::plain("ffmpeg_unexpected", "the FFmpeg download takes no command"))
    }

    fn started(&self) -> InstallState {
        InstallState::of("downloading")
    }

    fn on_line(&self, _state: &mut InstallState, _stream: Stream, _line: &str) {}

    fn on_exit(
        &self,
        state: &mut InstallState,
        _status: &ExitStatus,
        _stderr_tail: &[String],
        _attempt: u32,
    ) -> ExitAction {
        let _ = state;
        ExitAction::Finished
    }

    fn verify(&self) -> Result<Option<String>, CodedError> {
        // The download returns its path directly; nothing to verify.
        Ok(None)
    }
}

/// Where the Windows build lives after a download: `~/.openvids/ffmpeg`.
/// The home comes from `prefs::home_dir()` (the Windows-correct home), and
/// `OPENVIDS_FFMPEG_DIR` overrides it in tests only.
pub fn managed_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("OPENVIDS_FFMPEG_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    prefs::home_dir().join(".openvids").join("ffmpeg")
}

/// The installed executables when a downloaded build is in place.
/// `ffprobe.exe` ships in the same build; a half-installed directory (only
/// one of the two) counts as missing so the button repairs it.
pub fn managed_ffmpeg() -> Option<PathBuf> {
    let dir = managed_dir();
    let ffmpeg = dir.join("ffmpeg.exe");
    let ffprobe = dir.join("ffprobe.exe");
    (ffmpeg.is_file() && ffprobe.is_file()).then_some(ffmpeg)
}

/// The installed ffprobe, same rule as [`managed_ffmpeg`].
pub fn managed_ffprobe() -> Option<PathBuf> {
    let dir = managed_dir();
    let ffprobe = dir.join("ffprobe.exe");
    let ffmpeg = dir.join("ffmpeg.exe");
    (ffmpeg.is_file() && ffprobe.is_file()).then_some(ffprobe)
}

/// `HYPERFRAMES_FFMPEG_PATH` / `HYPERFRAMES_FFPROBE_PATH` pointing at the
/// downloaded build, or nothing when no build is installed. Computed at each
/// child spawn (sidecar, CLI, agent runtime), so a download that finishes
/// mid-session takes effect the next time a project opens without a restart.
/// Explicit user overrides in the environment win: they are left untouched.
pub fn managed_env() -> Vec<(String, String)> {
    // A caller-set override names a file the user chose; keep it even when
    // it points nowhere (the CLI reports it as missing, not as ours).
    let ffmpeg_var = std::env::var_os("HYPERFRAMES_FFMPEG_PATH").filter(|v| !v.is_empty());
    let ffprobe_var = std::env::var_os("HYPERFRAMES_FFPROBE_PATH").filter(|v| !v.is_empty());
    let mut env = Vec::new();
    if ffmpeg_var.is_none() {
        if let Some(ffmpeg) = managed_ffmpeg() {
            env.push(("HYPERFRAMES_FFMPEG_PATH".to_string(), ffmpeg.to_string_lossy().into_owned()));
        }
    }
    if ffprobe_var.is_none() {
        if let Some(ffprobe) = managed_ffprobe() {
            env.push(("HYPERFRAMES_FFPROBE_PATH".to_string(), ffprobe.to_string_lossy().into_owned()));
        }
    }
    env
}

/// The source URLs after the test override. `OPENVIDS_FFMPEG_URL` (and
/// `OPENVIDS_FFMPEG_SHA256_URL`) point the download at a local HTTP server,
/// so the network path is exercised offline; empty means the default.
/// Anything else must be https on the fixed host allow-list.
fn download_urls() -> Result<(String, String), CodedError> {
    // The pinned defaults carry the pinned version; refuse to drift apart.
    debug_assert!(WINDOWS_BUILD_URL.contains(WINDOWS_BUILD_VERSION));
    debug_assert!(WINDOWS_BUILD_SHA256_URL.contains(WINDOWS_BUILD_VERSION));
    let url = std::env::var("OPENVIDS_FFMPEG_URL")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| WINDOWS_BUILD_URL.to_string());
    let sha_url = std::env::var("OPENVIDS_FFMPEG_SHA256_URL")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| WINDOWS_BUILD_SHA256_URL.to_string());
    for candidate in [&url, &sha_url] {
        check_url(candidate)?;
    }
    Ok((url, sha_url))
}

/// https on the allow-list, or a loopback URL for tests
/// (`OPENVIDS_FFMPEG_URL` pointing at a local server).
fn check_url(raw: &str) -> Result<(), CodedError> {
    let parsed = url::Url::parse(raw)
        .map_err(|e| CodedError::plain("ffmpeg_bad_url", format!("the FFmpeg download address is not valid: {e}")))?;
    let is_override = std::env::var_os("OPENVIDS_FFMPEG_URL").is_some_and(|v| !v.is_empty());
    if is_override && is_loopback_url(&parsed) {
        return Ok(());
    }
    if parsed.scheme() != "https" {
        return Err(CodedError::plain(
            "ffmpeg_bad_url",
            "the FFmpeg download address must be https.",
        ));
    }
    let host = parsed.host_str().unwrap_or_default().to_lowercase();
    if !WINDOWS_BUILD_HOSTS.iter().any(|h| host == *h) {
        return Err(CodedError::plain(
            "ffmpeg_bad_url",
            "the FFmpeg download address is not on the allowed hosts.",
        ));
    }
    Ok(())
}

/// Loopback hosts (and `.localhost`) for the test download server.
/// `url::Url` has no `is_loopback()`; match by name instead. IPv6 loopback
/// arrives as "::1" without brackets from `host_str()`.
fn is_loopback_url(parsed: &url::Url) -> bool {
    match parsed.host_str().unwrap_or_default().to_lowercase().as_str() {
        "localhost" | "127.0.0.1" | "::1" => true,
        host => host.ends_with(".localhost"),
    }
}

/// SHA-256 of bytes in hex, lowercase.
fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// The publisher's checksum file holds `<hex>  <filename>` (or bare hex);
/// compare it against the downloaded bytes and refuse on any mismatch.
fn verify_checksum(archive: &[u8], checksum_body: &str) -> Result<(), CodedError> {
    let expected = checksum_body
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(CodedError::plain(
            "ffmpeg_bad_checksum",
            "the FFmpeg checksum file did not contain a SHA-256 hash.",
        ));
    }
    let actual = sha256_hex(archive);
    if actual != expected {
        return Err(CodedError::plain(
            "ffmpeg_checksum_mismatch",
            "the FFmpeg download did not match its published checksum, so it was discarded.",
        ));
    }
    Ok(())
}

/// Pick `ffmpeg.exe`/`ffprobe.exe` out of the build zip, safely: entry paths
/// must collapse inside the destination (`enclosed_name` rejects `..` and
/// absolute paths, and the extra `starts_with` is the belt), only regular
/// files land, and only the two executables plus the license/README text are
/// kept. Returns the installed binary names.
fn extract_build(archive: &[u8], dest: &Path) -> Result<Vec<String>, CodedError> {
    let fail = |detail: &str| CodedError::plain("ffmpeg_extract_failed", format!("could not unpack the FFmpeg download: {detail}"));
    let mut zip = zip::ZipArchive::new(io::Cursor::new(archive)).map_err(|e| fail(&e.to_string()))?;
    let mut kept = Vec::new();
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| fail(&e.to_string()))?;
        if entry.is_dir() {
            continue;
        }
        let Some(safe) = entry.enclosed_name() else {
            return Err(fail("an entry pointed outside the archive"));
        };
        let name = safe.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_lowercase();
        let keep = matches!(name.as_str(), "ffmpeg.exe" | "ffprobe.exe")
            || name == "license" || name == "license.txt" || name == "readme.txt";
        if !keep {
            continue;
        }
        // Belt after `enclosed_name`: a name like `a/../../x` that survived
        // must still land inside `dest`.
        let out = dest.join(&safe);
        if !out.starts_with(dest) {
            return Err(fail("an entry pointed outside the archive"));
        }
        if name == "ffmpeg.exe" || name == "ffprobe.exe" {
            kept.push(name.clone());
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| fail(&e.to_string()))?;
        }
        let mut file = std::fs::File::create(&out).map_err(|e| fail(&e.to_string()))?;
        io::copy(&mut entry, &mut file).map_err(|e| fail(&e.to_string()))?;
    }
    if !kept.contains(&"ffmpeg.exe".to_string()) || !kept.contains(&"ffprobe.exe".to_string()) {
        return Err(fail("ffmpeg.exe or ffprobe.exe was missing"));
    }
    kept.sort();
    kept.dedup();
    Ok(kept)
}

/// Remove stale `ffmpeg-*` temp/backup directories left by a killed download.
/// These live next to the managed dir (siblings), so the parent is swept.
/// Only our own prefix inside our own parent is ever touched.
fn sweep_stale_temp_dirs() {
    let dir = managed_dir();
    let parent = dir.parent().map(Path::to_path_buf).unwrap_or_else(|| dir.clone());
    let Ok(entries) = std::fs::read_dir(&parent) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("ffmpeg-") && (name.ends_with(".tmp") || name.ends_with(".bak")) && entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// The single blocking flow a Windows download runs: fetch the checksum file,
/// fetch the archive, refuse on mismatch, extract `ffmpeg.exe`/`ffprobe.exe`
/// plus license/README text into a temp dir, then atomically rename it over
/// the managed dir. `progress` mirrors byte counts into the slot; `cancelled`
/// flips when the job is cancelled or times out.
fn download_and_install(
    progress: &DownloadProgress,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<String, CodedError> {
    sweep_stale_temp_dirs();
    let (url, sha_url) = download_urls()?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30 * 60)))
        .http_status_as_error(false)
        .user_agent(format!("OpenVids/{} ({}; {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH))
        .build()
        .into();
    let checksum_body = fetch_text(&agent, &sha_url, cancelled)?;
    let archive = fetch_bytes(&agent, &url, progress, cancelled)?;
    verify_checksum(&archive, &checksum_body)?;
    install_archive(&archive)?;
    managed_ffmpeg()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| CodedError::plain("ffmpeg_not_found_after", "the FFmpeg download finished, but ffmpeg.exe was not found afterwards."))
}

/// GET a small text body (the checksum file), bounded to 64 KiB.
fn fetch_text(agent: &ureq::Agent, url: &str, cancelled: &std::sync::atomic::AtomicBool) -> Result<String, CodedError> {
    use std::io::Read;
    let mut response = agent.get(url).call().map_err(download_error)?;
    if !(200..300).contains(&response.status().as_u16()) {
        return Err(CodedError::plain("ffmpeg_download_failed", format!("the FFmpeg download failed (HTTP {})", response.status())));
    }
    let mut body = response.body_mut().with_config().limit(64 * 1024).reader();
    let mut text = String::new();
    loop {
        if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(CodedError::plain("ffmpeg_cancelled", "the FFmpeg download was cancelled."));
        }
        let mut chunk = [0u8; 8192];
        match body.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => text.push_str(&String::from_utf8_lossy(&chunk[..n])),
            Err(e) => return Err(CodedError::plain("ffmpeg_download_failed", format!("the FFmpeg download failed: {e}"))),
        }
    }
    Ok(text)
}

/// GET the archive with byte progress. Capped at 1 GiB.
fn fetch_bytes(
    agent: &ureq::Agent,
    url: &str,
    progress: &DownloadProgress,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<Vec<u8>, CodedError> {
    use std::io::Read;
    let mut response = agent.get(url).call().map_err(download_error)?;
    if !(200..300).contains(&response.status().as_u16()) {
        return Err(CodedError::plain("ffmpeg_download_failed", format!("the FFmpeg download failed (HTTP {})", response.status())));
    }
    let total = response.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).filter(|t| *t > 0);
    progress.set_total(total);
    let mut body = response.body_mut().with_config().limit(1024 * 1024 * 1024).reader();
    let mut archive = Vec::new();
    loop {
        if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(CodedError::plain("ffmpeg_cancelled", "the FFmpeg download was cancelled."));
        }
        let mut chunk = [0u8; 64 * 1024];
        match body.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                archive.extend_from_slice(&chunk[..n]);
                progress.add_downloaded(n as u64);
            }
            Err(e) => return Err(CodedError::plain("ffmpeg_download_failed", format!("the FFmpeg download failed: {e}"))),
        }
    }
    Ok(archive)
}

/// A ureq failure as our error: timeouts name the timeout, the rest stays short.
fn download_error(error: ureq::Error) -> CodedError {
    match error {
        ureq::Error::Timeout(_) => CodedError::plain("ffmpeg_download_timeout", "the FFmpeg download timed out."),
        _ => CodedError::plain("ffmpeg_download_failed", format!("the FFmpeg download failed: {error}")),
    }
}

/// Extract into `<managed>/ffmpeg-<nanos>.tmp`, then rename over `<managed>`.
/// The rename is the commit point: a kill before it leaves the previous
/// install (or nothing) in place, and the temp dir is swept next start.
fn install_archive(archive: &[u8]) -> Result<(), CodedError> {
    let dest = managed_dir();
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let temp = dest.with_file_name(format!("ffmpeg-{nanos}.tmp"));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp)
        .map_err(|e| CodedError::plain("ffmpeg_extract_failed", format!("could not unpack the FFmpeg download: {e}")))?;
    let result = extract_build(archive, &temp).and_then(|_| {
        flatten_build(&temp).map_err(|e| CodedError::plain("ffmpeg_extract_failed", format!("could not unpack the FFmpeg download: {e}")))
    });
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(error);
    }
    // Windows cannot rename over a non-empty dir: move the old one aside,
    // rename the temp in, and drop the backup. A kill between leaves either
    // the old install or a `.bak` the next sweep removes — never half files.
    let backup = dest.with_file_name(format!("ffmpeg-{nanos}.bak"));
    let _ = std::fs::remove_dir_all(&backup);
    if dest.exists() {
        if let Err(e) = std::fs::rename(&dest, &backup) {
            let _ = std::fs::remove_dir_all(&temp);
            return Err(CodedError::plain("ffmpeg_extract_failed", format!("could not unpack the FFmpeg download: {e}")));
        }
    }
    if let Err(e) = std::fs::rename(&temp, &dest) {
        // Put the old install back when the commit fails.
        if backup.exists() {
            let _ = std::fs::rename(&backup, &dest);
        }
        let _ = std::fs::remove_dir_all(&temp);
        return Err(CodedError::plain("ffmpeg_extract_failed", format!("could not unpack the FFmpeg download: {e}")));
    }
    let _ = std::fs::remove_dir_all(&backup);
    Ok(())
}

/// Move `ffmpeg.exe`/`ffprobe.exe` (and license/README text) from wherever
/// the zip put them (`bin/`, the top level) to the temp root, dropping the
/// rest. Matching is case-insensitive; only our own temp dir is walked.
fn flatten_build(temp: &Path) -> io::Result<()> {
    let mut found: Vec<PathBuf> = Vec::new();
    let mut stack = vec![temp.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                let lower = name.to_lowercase();
                if matches!(lower.as_str(), "ffmpeg.exe" | "ffprobe.exe" | "license" | "license.txt" | "readme.txt") {
                    found.push(path);
                }
            }
        }
    }
    for path in found {
        let name = path.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "an archive entry had no name"))?;
        let target = temp.join(name);
        if path != target {
            if target.exists() {
                let _ = std::fs::remove_file(&target);
            }
            std::fs::rename(&path, &target)?;
        }
    }
    // Drop everything but the flattened files.
    for entry in std::fs::read_dir(temp)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            std::fs::remove_dir_all(&path)?;
        } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            let lower = name.to_lowercase();
            if !matches!(lower.as_str(), "ffmpeg.exe" | "ffprobe.exe" | "license" | "license.txt" | "readme.txt") {
                std::fs::remove_file(&path)?;
            }
        }
    }
    Ok(())
}

/// Byte progress of the Windows download, shared with the job state.
#[derive(Debug, Default)]
struct DownloadProgress {
    downloaded: std::sync::atomic::AtomicU64,
    total: std::sync::atomic::AtomicU64,
}

impl DownloadProgress {
    fn new() -> Self {
        Self::default()
    }
    fn add_downloaded(&self, n: u64) {
        self.downloaded.fetch_add(n, std::sync::atomic::Ordering::Relaxed);
    }
    fn set_total(&self, total: Option<u64>) {
        self.total.store(total.unwrap_or(0), std::sync::atomic::Ordering::Relaxed);
    }
    fn snapshot(&self) -> (u64, Option<u64>) {
        let downloaded = self.downloaded.load(std::sync::atomic::Ordering::Relaxed);
        let total = self.total.load(std::sync::atomic::Ordering::Relaxed);
        (downloaded, (total > 0).then_some(total))
    }
}

/// `brew install ffmpeg` can take many minutes (dependencies, bottles, sometimes
/// builds from source). The Windows download is ~115 MB; half an hour is
/// generous even on a bad connection.
static BREW_JOB: InstallJob = InstallJob::new(&BrewInstaller, Duration::from_secs(60 * 60));
static DOWNLOAD_JOB: InstallJob = InstallJob::new(&DownloadInstaller, Duration::from_secs(30 * 60));

/// The job this platform installs with. One slot per tool: macOS keeps the
/// brew slot, Windows the download slot; each platform only ever touches its own.
fn job() -> &'static InstallJob {
    if cfg!(windows) { &DOWNLOAD_JOB } else { &BREW_JOB }
}

/// Cancel flag the active download's fetch loops poll. The slot carries no
/// child pid for an in-process download, so cancel/timeout flip this instead.
#[allow(clippy::incompatible_msrv)]
static DOWNLOAD_CANCEL: std::sync::LazyLock<std::sync::Arc<std::sync::atomic::AtomicBool>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)));

fn download_cancel_flag() -> std::sync::Arc<std::sync::atomic::AtomicBool> {
    std::sync::Arc::clone(&DOWNLOAD_CANCEL)
}

/// Start the download on a worker and mirror its progress into the
/// `DOWNLOAD_JOB` slot. Joins a running job; a finished one stays until the
/// next start. Cancellation flips the flag the fetch loops poll.
fn start_download() -> InstallState {
    use std::sync::atomic::Ordering;
    let job: &'static InstallJob = &DOWNLOAD_JOB;
    let already = job.with_slot(|slot| {
        if slot.state.is_active() {
            return Ok(slot.state.clone());
        }
        slot.generation += 1;
        let generation = slot.generation;
        slot.tail.clear();
        slot.pid = None;
        slot.state = DownloadInstaller.started();
        Err(generation)
    });
    let generation = match already {
        Ok(running) => return running,
        Err(generation) => generation,
    };
    let cancelled = download_cancel_flag();
    cancelled.store(false, Ordering::Relaxed);
    let progress = std::sync::Arc::new(DownloadProgress::new());
    let progress_tick = progress.clone();
    let cancelled_tick = cancelled.clone();
    std::thread::spawn(move || {
        // Mirror byte counts while the worker downloads.
        loop {
            std::thread::sleep(Duration::from_millis(100));
            let alive = job.with_slot(|slot| slot.generation == generation && slot.state.is_active());
            if !alive {
                break;
            }
            let (downloaded, total) = progress_tick.snapshot();
            let done = job.with_slot(|slot| {
                if slot.generation != generation || !slot.state.is_active() {
                    return true;
                }
                slot.state.phase = if total.map(|t| downloaded >= t).unwrap_or(false) { "installing" } else { "downloading" };
                slot.state.downloaded = Some(downloaded);
                slot.state.total = total;
                false
            });
            if done || cancelled_tick.load(Ordering::Relaxed) {
                break;
            }
        }
    });
    let run = DownloadRun { job, generation, progress, cancelled: cancelled.clone() };
    std::thread::spawn(move || DownloadInstaller::run(run));
    // The watchdog: fail a download that outlives the timeout.
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(30 * 60);
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let active = job.with_slot(|slot| slot.generation == generation && slot.state.is_active());
            if !active {
                return;
            }
            if std::time::Instant::now() >= deadline {
                job.with_slot(|slot| {
                    if slot.generation == generation && slot.state.is_active() {
                        slot.state = InstallState::failed_with(&CodedError::new(
                            "install_timeout",
                            "the install took longer than 30 minutes and was stopped",
                            serde_json::json!({ "minutes": 30 }),
                        ));
                    }
                });
                download_cancel_flag().store(true, Ordering::Relaxed);
                return;
            }
        }
    });
    job.state()
}

pub fn state() -> InstallState {
    job().state()
}

pub fn start() -> InstallState {
    if cfg!(windows) {
        return start_download();
    }
    BREW_JOB.start()
}

pub fn cancel() -> InstallState {
    if cfg!(windows) {
        let job = &DOWNLOAD_JOB;
        let now = job.state();
        if !now.is_active() {
            return now;
        }
        download_cancel_flag().store(true, std::sync::atomic::Ordering::Relaxed);
        job.with_slot(|slot| {
            if slot.state.is_active() {
                slot.state = InstallState::of("cancelled");
            }
        });
        return job.state();
    }
    BREW_JOB.cancel()
}

pub fn shutdown() {
    if cfg!(windows) {
        download_cancel_flag().store(true, std::sync::atomic::Ordering::Relaxed);
        DOWNLOAD_JOB.with_slot(|slot| {
            if slot.state.is_active() {
                slot.state = InstallState::of("cancelled");
            }
        });
        return;
    }
    BREW_JOB.shutdown();
}

#[cfg(test)]
pub fn reset() {
    if cfg!(windows) {
        download_cancel_flag().store(true, std::sync::atomic::Ordering::Relaxed);
    }
    BREW_JOB.reset();
    DOWNLOAD_JOB.reset();
}
/// Serializes every test that touches the FFmpeg env overrides
/// (`OPENVIDS_FFMPEG_DIR`, `OPENVIDS_FFMPEG_URL`, `OPENVIDS_FFMPEG_SHA256_URL`,
/// `HYPERFRAMES_*_PATH`): they are process-wide, so parallel tests would
/// otherwise read each other's values.
#[cfg(test)]
pub(crate) static FFMPEG_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_runner::tests::with_fake_cli;
    use crate::install_job::test_support::{process_alive, wait_for, wait_until_gone};
    use std::sync::Mutex;

    static FAKE_BREW_LOCK: Mutex<()> = Mutex::new(());

    // Bun scripts: the fake CLI (and the fake brew below) run on `bun`, which
    // is on PATH in dev/test on both platforms. `sh` scripts cannot run on
    // Windows, and `.cmd` cannot express the branching the tests need.
    #[cfg(unix)]
    const CLI_FOUND: &str = r#"console.log('{"tools":{"ffmpeg":{"found":true,"path":"/opt/homebrew/bin/ffmpeg","version":"9.0.2"},"ffprobe":{"found":true,"path":"/opt/homebrew/bin/ffprobe"},"chrome":{"found":false}}}')"#;
    #[cfg(windows)]
    const CLI_FOUND: &str = r#"console.log(JSON.stringify({tools:{ffmpeg:{found:true,path:"C:\\ffmpeg\\ffmpeg.exe",version:"9.0.2"},ffprobe:{found:true,path:"C:\\ffmpeg\\ffprobe.exe"},chrome:{found:false}}}))"#;
    #[cfg(unix)]
    const CLI_MISSING: &str = r#"console.log('{"tools":{"ffmpeg":{"found":false},"ffprobe":{"found":false},"chrome":{"found":false}}}')"#;
    #[cfg(windows)]
    const CLI_MISSING: &str = r#"console.log(JSON.stringify({tools:{ffmpeg:{found:false},ffprobe:{found:false},chrome:{found:false}}}))"#;

    /// Runs `body` with a fake `brew` (a bun script: argv branching works on
    /// both platforms) and a fake CLI answering the verification.
    fn with_fake_brew<T>(brew_script: &str, cli_script: &str, body: impl FnOnce(&Path) -> T) -> T {
        with_fake_cli(cli_script, || {
            let _guard = FAKE_BREW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let dir = std::env::temp_dir().join(format!(
                "openvids-fake-brew-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(dir.join("bin")).unwrap();
            let brew = dir.join("bin").join("brew.mjs");
            std::fs::write(&brew, brew_script).unwrap();
            std::env::set_var("OPENVIDS_BREW_PATH", &brew);
            // The user's own HOMEBREW_* settings reach brew on purpose; the fake brews model a user
            // without them (CI runners set HOMEBREW_NO_AUTO_UPDATE globally).
            let user_no_auto_update = std::env::var_os("HOMEBREW_NO_AUTO_UPDATE");
            std::env::remove_var("HOMEBREW_NO_AUTO_UPDATE");
            BREW_JOB.reset();
            let out = body(&dir);
            if let Some(value) = user_no_auto_update {
                std::env::set_var("HOMEBREW_NO_AUTO_UPDATE", value);
            }
            std::env::remove_var("OPENVIDS_BREW_PATH");
            let _ = std::fs::remove_dir_all(&dir);
            out
        })
    }

    #[cfg(unix)]
    fn status(code: i32) -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(code << 8)
    }

    #[cfg(windows)]
    fn status(code: u32) -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(code)
    }

    #[test]
    fn output_lines_are_sanitised_into_one_bounded_line() {
        assert_eq!(sanitize_line("==> Downloading https://ghcr.io/v2/homebrew/core/x264/blobs").unwrap(), "Downloading https://ghcr.io/v2/homebrew/core/x264/blobs");
        assert_eq!(sanitize_line("\u{1b}[34m==>\u{1b}[0m \u{1b}[1mPouring ffmpeg--9.0.2.arm64.bottle.tar.gz\u{1b}[0m").unwrap(), "Pouring ffmpeg--9.0.2.arm64.bottle.tar.gz");
        // Progress bars redraw one line with \r: only the last redraw counts.
        assert_eq!(sanitize_line("Fetching x264\r######## 12.0%\rFetching x265").unwrap(), "Fetching x265");
        assert_eq!(sanitize_line("a\u{7}b\u{0}c\tfoo   bar").unwrap(), "abc foo bar");
        assert!(sanitize_line("######################## 100.0%").is_none());
        assert!(sanitize_line("   \r  ").is_none());
        assert!(sanitize_line("").is_none());
        let long = sanitize_line(&"x".repeat(1000)).unwrap();
        assert_eq!(long.chars().count(), DETAIL_CHARS);
        // Never more than one line, whatever it is fed.
        assert!(!sanitize_line("one\ntwo").unwrap().contains('\n'));
    }

    #[test]
    fn failures_get_a_one_line_reason_from_the_stderr_tail() {
        let tail = |lines: &[&str]| lines.iter().map(|l| l.to_string()).collect::<Vec<_>>();
        assert_eq!(
            failure_reason(&tail(&["Warning: x", "Error: ffmpeg: no bottle available!"]), &status(1)).message,
            "Error: ffmpeg: no bottle available!"
        );
        assert_eq!(
            failure_reason(&tail(&["Error: boom", "trailing note"]), &status(1)).message,
            "Error: boom"
        );
        assert_eq!(failure_reason(&tail(&["just text"]), &status(1)).message, "just text");
        assert_eq!(failure_reason(&tail(&["just text"]), &status(1)).code, None);
        let failed = failure_reason(&[], &status(2));
        assert!(failed.message.contains("brew install ffmpeg"));
        assert_eq!(failed.code, Some("brew_failed"));
        for needs in [
            "sudo: a terminal is required to read the password",
            "Error: Need sudo access on macOS",
            "Please enter your password",
        ] {
            let reason = failure_reason(&tail(&[needs]), &status(1));
            assert!(reason.message.contains("Run `brew install ffmpeg` in Terminal"), "{}", reason.message);
            assert_eq!(reason.code, Some("brew_needs_terminal"));
        }
        assert!(looks_stale("Error: No available formula with the name \"ffmpeg\""));
        assert!(looks_stale("curl: (22) The requested URL returned error: 404"));
        assert!(!looks_stale("Error: disk full"));
    }

    #[test]
    fn brew_is_found_through_the_override_only_when_it_exists() {
        let _cli = crate::cli_runner::tests::FAKE_CLI_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _guard = FAKE_BREW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("OPENVIDS_BREW_PATH", "/definitely/not/brew");
        assert!(find_brew().is_none(), "an override that points nowhere is not a fallback to the system brew");
        std::env::remove_var("OPENVIDS_BREW_PATH");
    }

    #[test]
    fn a_successful_install_streams_detail_then_is_done_and_the_environment_is_sane() {
        let dir_probe = std::env::temp_dir().join(format!("openvids-brew-env-{}", std::process::id()));
        let probe_escaped = dir_probe.display().to_string().replace('\\', "\\\\");
        let mut script = format!(
            "const {{writeFileSync, readFileSync}} = await import('node:fs');\nconst p = '{p}';\nwriteFileSync(p, Object.entries(process.env).map(([k,v]) => k + '=' + v).join('\\n') + '\\nargs: ' + process.argv.slice(2).join(' ') + '\\n');\n",
            p = probe_escaped,
        );
        script.push_str("try { readFileSync('/dev/tty'); writeFileSync(p, '\\nHAS_TTY', {flag:'a'}); } catch { writeFileSync(p, '\\nNO_TTY', {flag:'a'}); }\n");
        script.push_str("writeFileSync(p, '\\nSTDIN_CLOSED', {flag:'a'});\n");
        script.push_str("console.log('==> Fetching ffmpeg');\nawait Bun.sleep(1000);\nconsole.log('==> Pouring ffmpeg--9.0.2.arm64.bottle.tar.gz');\nawait Bun.sleep(1000);\nconsole.error('done');\n");
        with_fake_brew(&script, CLI_FOUND, |_| {
            // Drive the brew slot directly: on Windows `start()` enters the
            // download slot, so the brew flow is unreachable through it.
            let first = BREW_JOB.start();
            assert_eq!(first.phase, "installing");
            let mid = wait_for(&BREW_JOB, "a streamed line", |s| {
                s.detail.as_deref() == Some("Fetching ffmpeg")
            });
            assert_eq!(mid.phase, "installing");
            // A second start while it runs joins it.
            let generation = BREW_JOB.generation();
            assert!(BREW_JOB.start().is_active());
            assert_eq!(BREW_JOB.generation(), generation);
            wait_for(&BREW_JOB, "the next line", |s| {
                s.detail.as_deref() == Some("Pouring ffmpeg--9.0.2.arm64.bottle.tar.gz")
            });
            let done = wait_for(&BREW_JOB, "done", |s| s.phase == "done");
            #[cfg(unix)]
            assert_eq!(done.path.as_deref(), Some("/opt/homebrew/bin/ffmpeg"));
            #[cfg(windows)]
            assert_eq!(done.path.as_deref(), Some("C:\\ffmpeg\\ffmpeg.exe"));
            assert_eq!(done.detail, None);
            assert_eq!(done.error, None);
            wait_for(&BREW_JOB, "reaped", |_| BREW_JOB.pid().is_none());
        });
        let seen = std::fs::read_to_string(&dir_probe).unwrap();
        let _ = std::fs::remove_file(&dir_probe);
        assert!(seen.contains("args: install ffmpeg"), "{seen}");
        for var in [
            "NONINTERACTIVE=1",
            "HOMEBREW_NO_ENV_HINTS=1",
            "HOMEBREW_NO_AUTO_UPDATE=1",
            "HOMEBREW_NO_INSTALL_UPGRADE=1",
            "HOMEBREW_NO_INSTALL_CLEANUP=1",
            "HOMEBREW_NO_ANALYTICS=1",
        ] {
            assert!(seen.lines().any(|l| l == var), "{var} missing in:\n{seen}");
        }
        let path_line = seen.lines().find(|l| l.starts_with("PATH=")).unwrap();
        assert!(path_line.contains("/bin:") && path_line.contains("/sbin") && path_line.contains(":/usr/bin:/bin"), "{path_line}");
        assert!(seen.contains("NO_TTY"), "brew has no controlling terminal");
        assert!(seen.contains("STDIN_CLOSED"), "stdin is closed, so nothing can wait on a prompt");
    }

    #[test]
    fn a_non_zero_exit_fails_with_the_reason_from_stderr() {
        with_fake_brew(
            "console.log('==> Fetching ffmpeg');\nconsole.error('Warning: noise');\nconsole.error('Error: ffmpeg: disk full');\nprocess.exit(1);\n",
            CLI_FOUND,
            |_| {
                BREW_JOB.start();
                let s = wait_for(&BREW_JOB, "failed", |s| s.phase == "failed");
                assert_eq!(s.error.as_deref(), Some("Error: ffmpeg: disk full"));
                assert_eq!(s.detail, None);
            },
        );
    }

    #[test]
    fn needing_sudo_or_a_prompt_fails_clearly_and_never_hangs() {
        let started = std::time::Instant::now();
        with_fake_brew(
            "console.error('sudo: a terminal is required to read the password; either use ssh or the -S option');\nprocess.exit(1);\n",
            CLI_FOUND,
            |_| {
                BREW_JOB.start();
                let s = wait_for(&BREW_JOB, "failed", |s| s.phase == "failed");
                assert!(s.error.unwrap().contains("Run `brew install ffmpeg` in Terminal"));
            },
        );
        // A brew that waits for input gets EOF immediately and gives up.
        // `Promise.race` with a timeout keeps the test fast even if the
        // runtime holds stdin open without EOF on some platform.
        with_fake_brew(
            "process.stderr.write('Press RETURN to continue: ');\nconst chunks = [];\nawait Promise.race([ (async () => { for await (const c of process.stdin) chunks.push(c); })(), Bun.sleep(2000) ]);\nconsole.error('Error: no input available');\nprocess.exit(1);\n",
            CLI_FOUND,
            |_| {
                BREW_JOB.start();
                let s = wait_for(&BREW_JOB, "failed", |s| s.phase == "failed");
                assert!(s.error.is_some());
            },
        );
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn a_stale_looking_failure_retries_once_with_auto_update_allowed() {
        let probe = std::env::temp_dir().join(format!("openvids-brew-attempts-{}", std::process::id()));
        let _ = std::fs::remove_file(&probe);
        let probe_escaped = probe.display().to_string().replace('\\', "\\\\");
        let mut script = format!(
            "const {{appendFileSync}} = await import('node:fs');\nappendFileSync('{p}', 'NO_AUTO_UPDATE=' + (process.env.HOMEBREW_NO_AUTO_UPDATE || 'unset') + '\\n');\n",
            p = probe_escaped,
        );
        script.push_str("if (process.env.HOMEBREW_NO_AUTO_UPDATE) { console.error('Error: No available formula with the name \"ffmpeg\"'); process.exit(1); }\n");
        script.push_str("console.log('==> Updating Homebrew');\n");
        with_fake_brew(&script, CLI_FOUND, |_| {
            BREW_JOB.start();
            let done = wait_for(&BREW_JOB, "done after the retry", |s| s.phase == "done");
            #[cfg(unix)]
            assert_eq!(done.path.as_deref(), Some("/opt/homebrew/bin/ffmpeg"));
            #[cfg(windows)]
            assert_eq!(done.path.as_deref(), Some("C:\\ffmpeg\\ffmpeg.exe"));
        });
        let attempts = std::fs::read_to_string(&probe).unwrap();
        let _ = std::fs::remove_file(&probe);
        assert_eq!(attempts.lines().collect::<Vec<_>>(), vec!["NO_AUTO_UPDATE=1", "NO_AUTO_UPDATE=unset"]);

        // A failure that is not about stale metadata is not retried.
        let counter = std::env::temp_dir().join(format!("openvids-brew-count-{}", std::process::id()));
        let _ = std::fs::remove_file(&counter);
        let counter_escaped = counter.display().to_string().replace('\\', "\\\\");
        let script = format!(
            "const {{appendFileSync}} = await import('node:fs');\nappendFileSync('{p}', 'run\\n');\nconsole.error('Error: disk full');\nprocess.exit(1);\n",
            p = counter_escaped,
        );
        with_fake_brew(&script, CLI_FOUND, |_| {
            BREW_JOB.start();
            wait_for(&BREW_JOB, "failed", |s| s.phase == "failed");
        });
        assert_eq!(std::fs::read_to_string(&counter).unwrap().lines().count(), 1);
        let _ = std::fs::remove_file(&counter);
    }

    #[test]
    fn a_retry_that_fails_again_is_one_failure() {
        with_fake_brew(
            "console.error('Error: No available formula with the name \"ffmpeg\"');\nprocess.exit(1);\n",
            CLI_FOUND,
            |_| {
                BREW_JOB.start();
                let s = wait_for(&BREW_JOB, "failed", |s| s.phase == "failed");
                assert!(s.error.unwrap().contains("No available formula"));
            },
        );
    }


    #[test]
    fn brew_succeeding_without_ffmpeg_findable_afterwards_is_a_failure() {
        with_fake_brew("console.log('==> Pouring');\n", CLI_MISSING, |_| {
            BREW_JOB.start();
            let s = wait_for(&BREW_JOB, "failed", |s| s.phase == "failed");
            assert!(s.error.unwrap().contains("not found afterwards"));
        });
    }

    #[test]
    fn cancel_kills_brew_and_everything_it_started_and_stays_cancelled() {
        let pid_file = std::env::temp_dir().join(format!("openvids-brew-sleeper-{}", std::process::id()));
        let _ = std::fs::remove_file(&pid_file);
        let pid_escaped = pid_file.display().to_string().replace('\\', "\\\\");
        let mut script = format!(
            "const {{writeFileSync}} = await import('node:fs');\nconst p = '{p}';\n",
            p = pid_escaped,
        );
        script.push_str("const {spawn} = await import('node:child_process');\n");
        script.push_str("const sleeper = spawn(process.execPath, ['-e', 'await new Promise(() => {});'], {stdio: 'ignore'});\n");
        script.push_str("writeFileSync(p, String(sleeper.pid));\n");
        script.push_str("console.log('==> Downloading x264');\nawait new Promise(() => {});\n");
        with_fake_brew(&script, CLI_FOUND, |_| {
            BREW_JOB.start();
            wait_for(&BREW_JOB, "downloading line", |s| s.detail.as_deref() == Some("Downloading x264"));
            let pid = BREW_JOB.pid().expect("a running job has a pid");
            let sleeper: u32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
            assert!(process_alive(pid) && process_alive(sleeper));
            assert_eq!(BREW_JOB.cancel().phase, "cancelled");
            wait_for(&BREW_JOB, "reaped", |_| BREW_JOB.pid().is_none());
            assert!(!process_alive(pid));
            wait_until_gone(sleeper);
            assert_eq!(BREW_JOB.state().phase, "cancelled");
            assert_eq!(BREW_JOB.cancel().phase, "cancelled");
        });
        let _ = std::fs::remove_file(&pid_file);
    }

    #[test]
    #[cfg(unix)]
    fn cancel_escalates_for_a_brew_that_ignores_sigterm() {
        with_fake_brew("trap '' TERM\necho '==> Building'\nwhile true; do sleep 1; done\n", CLI_FOUND, |_| {
            BREW_JOB.start();
            wait_for(&BREW_JOB, "running", |s| s.detail.as_deref() == Some("Building"));
            let pid = BREW_JOB.pid().unwrap();
            BREW_JOB.cancel();
            wait_for(&BREW_JOB, "killed after the grace period", |_| BREW_JOB.pid().is_none());
            assert!(!process_alive(pid));
        });
    }

    #[test]
    #[cfg(unix)]
    fn without_homebrew_start_is_a_clear_failure_and_nothing_runs() {
        let _cli = crate::cli_runner::tests::FAKE_CLI_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _guard = FAKE_BREW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("OPENVIDS_BREW_PATH", "/definitely/not/brew");
        BREW_JOB.reset();
        let s = BREW_JOB.start();
        std::env::remove_var("OPENVIDS_BREW_PATH");
        assert_eq!(s.phase, "failed");
        let error = s.error.unwrap();
        assert!(error.contains("Homebrew was not found") && error.contains("https://brew.sh"), "{error}");
    }

    #[test]
    fn shutdown_stops_a_running_install() {
        with_fake_brew("console.log('==> Fetching');\nawait new Promise(() => {});\n", CLI_FOUND, |_| {
            BREW_JOB.start();
            wait_for(&BREW_JOB, "running", |s| s.detail.as_deref() == Some("Fetching"));
            let pid = BREW_JOB.pid().unwrap();
            BREW_JOB.shutdown();
            wait_until_gone(pid);
            assert_eq!(BREW_JOB.state().phase, "cancelled");
        });
    }

    /// A tiny zip holding one `content` file at `path`, for the pure helpers.
    fn tiny_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        use std::io::Write;
        let mut out = std::io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(&mut out);
        let options = zip::write::SimpleFileOptions::default();
        for (path, content) in entries {
            writer.start_file(*path, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
        out.into_inner()
    }

    fn with_managed_dir<T>(body: impl FnOnce() -> T) -> T {
        let _lock = FFMPEG_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "openvids-managed-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
        ));
        std::env::set_var("OPENVIDS_FFMPEG_DIR", &dir);
        let out = body();
        std::env::remove_var("OPENVIDS_FFMPEG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    #[test]
    fn checksums_match_byte_for_byte() {
        let bytes = b"fake archive bytes";
        let hex = sha256_hex(bytes);
        assert_eq!(hex.len(), 64);
        verify_checksum(bytes, &hex).unwrap();
        verify_checksum(bytes, &format!("{hex}  ffmpeg.zip")).unwrap();
        verify_checksum(bytes, &hex.to_uppercase()).unwrap();
        let bad = verify_checksum(bytes, &"0".repeat(64)).unwrap_err();
        assert_eq!(bad.code, Some("ffmpeg_checksum_mismatch"));
        let unreadable = verify_checksum(bytes, "not a hash").unwrap_err();
        assert_eq!(unreadable.code, Some("ffmpeg_bad_checksum"));
    }

    #[test]
    fn zip_slip_entries_are_refused() {
        let evil = tiny_zip(&[("../../evil.exe", "x"), ("bin/ffmpeg.exe", "f"), ("bin/ffprobe.exe", "p")]);
        let dest = std::env::temp_dir().join(format!("openvids-slip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::create_dir_all(&dest).unwrap();
        let err = extract_build(&evil, &dest).unwrap_err();
        assert_eq!(err.code, Some("ffmpeg_extract_failed"));
        let _ = std::fs::remove_dir_all(&dest);
        // Only the two executables (plus license text) land; the rest is dropped.
        let mixed = tiny_zip(&[("bin/ffmpeg.exe", "f"), ("bin/ffprobe.exe", "p"), ("bin/other.dll", "d"), ("LICENSE", "l")]);
        let dest2 = std::env::temp_dir().join(format!("openvids-kept-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dest2);
        std::fs::create_dir_all(&dest2).unwrap();
        let kept = extract_build(&mixed, &dest2).unwrap();
        assert!(kept.contains(&"ffmpeg.exe".to_string()) && kept.contains(&"ffprobe.exe".to_string()));
        flatten_build(&dest2).unwrap();
        assert!(dest2.join("ffmpeg.exe").is_file() && dest2.join("ffprobe.exe").is_file());
        assert!(!dest2.join("bin/other.dll").exists());
        let _ = std::fs::remove_dir_all(&dest2);
    }

    #[test]
    fn installs_are_atomic_and_stale_temps_are_swept() {
        with_managed_dir(|| {
            let first = tiny_zip(&[("bin/ffmpeg.exe", "one"), ("bin/ffprobe.exe", "one"), ("LICENSE", "l")]);
            install_archive(&first).unwrap();
            assert_eq!(std::fs::read(managed_dir().join("ffmpeg.exe")).unwrap(), b"one");
            // A bad archive never touches the live install.
            assert!(install_archive(b"not a zip").is_err());
            assert_eq!(std::fs::read(managed_dir().join("ffmpeg.exe")).unwrap(), b"one");
            let second = tiny_zip(&[("ffmpeg.exe", "two"), ("ffprobe.exe", "two")]);
            install_archive(&second).unwrap();
            assert_eq!(std::fs::read(managed_dir().join("ffmpeg.exe")).unwrap(), b"two");
            // Stale temp/backup dirs from a killed download are swept on the next run.
            // They live next to the managed dir, not inside it.
            let parent = managed_dir().parent().map(Path::to_path_buf).unwrap();
            std::fs::create_dir_all(parent.join("ffmpeg-1.tmp")).unwrap();
            std::fs::create_dir_all(parent.join("ffmpeg-2.bak")).unwrap();
            std::fs::create_dir_all(parent.join("ffmpeg-keep")).unwrap();
            sweep_stale_temp_dirs();
            assert!(!parent.join("ffmpeg-1.tmp").exists());
            assert!(!parent.join("ffmpeg-2.bak").exists());
            assert!(parent.join("ffmpeg-keep").exists());
        });
    }

    #[test]
    fn download_urls_only_allow_the_pinned_host_or_loopback() {
        let _lock = FFMPEG_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("OPENVIDS_FFMPEG_URL", "http://evil.example/ffmpeg.zip");
        assert!(download_urls().is_err());
        std::env::set_var("OPENVIDS_FFMPEG_URL", "https://evil.example/ffmpeg.zip");
        assert!(download_urls().is_err());
        std::env::set_var("OPENVIDS_FFMPEG_URL", "http://127.0.0.1:9/ffmpeg.zip");
        std::env::set_var("OPENVIDS_FFMPEG_SHA256_URL", "http://127.0.0.1:9/ffmpeg.zip.sha256");
        assert!(download_urls().is_ok());
        std::env::remove_var("OPENVIDS_FFMPEG_URL");
        std::env::remove_var("OPENVIDS_FFMPEG_SHA256_URL");
        let (url, sha) = download_urls().unwrap();
        assert_eq!(url, WINDOWS_BUILD_URL);
        assert_eq!(sha, WINDOWS_BUILD_SHA256_URL);
        // The pinned defaults carry the pinned build version.
        assert!(url.contains(WINDOWS_BUILD_VERSION) && sha.contains(WINDOWS_BUILD_VERSION));
    }

    #[test]
    fn managed_env_points_children_at_the_download_until_the_user_overrides() {
        with_managed_dir(|| {
            assert!(managed_env().is_empty());
            std::fs::create_dir_all(managed_dir()).unwrap();
            std::fs::write(managed_dir().join("ffmpeg.exe"), "f").unwrap();
            std::fs::write(managed_dir().join("ffprobe.exe"), "p").unwrap();
            let env = managed_env();
            assert!(env.iter().any(|(k, v)| k == "HYPERFRAMES_FFMPEG_PATH" && v.ends_with("ffmpeg.exe")));
            assert!(env.iter().any(|(k, v)| k == "HYPERFRAMES_FFPROBE_PATH" && v.ends_with("ffprobe.exe")));
            std::env::set_var("HYPERFRAMES_FFMPEG_PATH", "C:\\user\\ffmpeg.exe");
            let env = managed_env();
            assert!(!env.iter().any(|(k, _)| k == "HYPERFRAMES_FFMPEG_PATH"));
            assert!(env.iter().any(|(k, _)| k == "HYPERFRAMES_FFPROBE_PATH"));
            std::env::remove_var("HYPERFRAMES_FFMPEG_PATH");
        });
    }
}
