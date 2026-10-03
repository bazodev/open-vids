//! In-app updates: check GitHub Releases, download, verify, install, restart.
//!
//! Rust drives all of it through `tauri-plugin-updater`; the webview has no
//! access to the plugin (no capability, no `withGlobalTauri`). The pages reach
//! it through the home server (`home_update`), the native menu through
//! `menu_check`.
//!
//! One slot holds the state:
//! `idle` → `checking` → `upToDate` | `available` | `failed`;
//! `available` → `downloading` → `ready` (update package downloaded, minisign
//! signature verified with the updater key in `tauri.conf.json`) → install →
//! restart, or `failed`.
//!
//! - `check` starts a check unless one runs or an update is being applied.
//! - `install` downloads the available update and, once `ready`, stops the
//!   processes the app owns (Studio sidecar group, agent runtimes, install jobs:
//!   the same path as quitting) and installs. A project that is rendering or
//!   running an agent turn refuses without `force`, so the page or a native
//!   dialog can ask first; a download that finishes while the project is busy
//!   parks in `ready` and asks the same way.
//! - The slot's mutex is never held across network, disk or dialog work:
//!   callers lock, copy or move out, release.
//!
//! Installing is per platform: macOS swaps the `.app` bundle in place and this
//! process relaunches it; Windows hands the downloaded NSIS installer to the
//! updater plugin, which runs it (passive, relaunching the app by default) and
//! exits this process itself. Stopping what the app owns happens before either,
//! while this process still can: on Windows the installer cannot overwrite the
//! files a running process holds open. Nothing here assumes a layered update
//! cannot later swap what `apply` installs.

use std::cmp::Ordering;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri_plugin_updater::{Update, UpdaterExt};

use super::coded_error::CodedError;
use super::{i18n, prefs};

/// The app's own version (`[package].version` in Cargo.toml, the single source).
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// How long after launch the automatic check runs.
const AUTO_CHECK_DELAY: Duration = Duration::from_secs(15);
/// The check request (`latest.json`); the download has no overall deadline.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// Release notes beyond this are cut: they are shown in a settings row and a dialog.
const NOTES_LIMIT: usize = 20_000;

/// The slot: what the page and the menu show.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum UpdateState {
    Idle,
    Checking,
    UpToDate,
    Available {
        version: String,
        notes: Option<String>,
        date: Option<String>,
    },
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
    },
    /// Downloaded and verified. `restarting`: being installed now; otherwise
    /// parked until the user agrees to restart a busy project.
    Ready {
        version: String,
        restarting: bool,
    },
    Failed {
        error: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<&'static str>,
        params: Value,
    },
}

impl UpdateState {
    fn failed(err: &CodedError) -> Self {
        Self::Failed {
            error: err.message.clone(),
            code: err.code,
            params: err.params.clone(),
        }
    }

    /// The JSON the pages get: the state plus `currentVersion`.
    pub fn to_json(&self) -> Value {
        let mut value = serde_json::to_value(self).unwrap_or_else(|_| json!({ "phase": "idle" }));
        value["currentVersion"] = json!(CURRENT_VERSION);
        value
    }
}

/// Whether `offered` is an update for `current`: strictly newer by semver
/// precedence (numeric parts, a pre-release below its release, build metadata
/// ignored). Never a downgrade, never the same version again.
pub fn is_newer(current: &semver::Version, offered: &semver::Version) -> bool {
    offered.cmp_precedence(current) == Ordering::Greater
}

/// The manifest key holding this build's update, as the updater plugin
/// resolves it: `{os}-{arch}` (`windows-x86_64` for the Windows NSIS builds,
/// `darwin-aarch64` / `darwin-x86_64` for macOS). `None` where the plugin
/// supports no target.
#[cfg_attr(not(test), allow(dead_code))]
pub fn update_target() -> Option<String> {
    tauri_plugin_updater::target()
}

/// Manifest keys the plugin tries, in order: `{base}-{bundle}` (e.g.
/// `windows-x86_64-nsis`) then `{base}` (`windows-x86_64`). `bundle` is the
/// installer kind for the running bundle (`nsis`, `msi`, `app`, …), if known.
#[cfg_attr(not(test), allow(dead_code))]
pub fn candidate_targets(base: &str, bundle: Option<&str>) -> Vec<String> {
    bundle
        .filter(|bundle| !bundle.is_empty())
        .map(|bundle| vec![format!("{base}-{bundle}"), base.to_string()])
        .unwrap_or_else(|| vec![base.to_string()])
}

/// The first of `candidates` present in the static manifest's `platforms`
/// map: the entry the plugin would download for this build.
#[cfg_attr(not(test), allow(dead_code))]
pub fn select_platform_key(manifest: &Value, candidates: &[String]) -> Option<String> {
    let platforms = manifest.get("platforms")?.as_object()?;
    candidates
        .iter()
        .find(|key| platforms.contains_key(key.as_str()))
        .cloned()
}

/// One `latest.json` response reduced to what a check needs for one target:
/// the announced version, notes and date plus that target's download URL and
/// signature. Accepts the static shape (`platforms` map) and the dynamic one
/// (a top-level `url`/`signature` for the requesting platform). `None` when
/// the shape is wrong or the target is missing.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct ManifestRelease {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub url: String,
    pub signature: String,
}

/// Read `manifest` for `target`. Mirrors what `find_update` keeps from the
/// plugin's answer (notes trimmed and cut to `NOTES_LIMIT`). A test-only
/// mirror of the plugin's own target resolution, so the Windows manifest
/// shape can be pinned without a live release.
#[cfg_attr(not(test), allow(dead_code))]
pub fn parse_manifest_release(manifest: &Value, target: &str) -> Option<ManifestRelease> {
    let version = manifest.get("version")?.as_str()?;
    let entry = manifest
        .get("platforms")
        .and_then(|platforms| platforms.get(target))
        .or_else(|| {
            if manifest.get("url").is_some() {
                Some(manifest)
            } else {
                None
            }
        })?;
    Some(ManifestRelease {
        version: version.to_string(),
        notes: manifest
            .get("notes")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|notes| !notes.is_empty())
            .map(|notes| notes.chars().take(NOTES_LIMIT).collect()),
        date: manifest
            .get("pub_date")
            .and_then(Value::as_str)
            .map(str::to_string),
        url: entry.get("url")?.as_str()?.to_string(),
        signature: entry.get("signature")?.as_str()?.to_string(),
    })
}

/// What a check found, apart from the plugin's `Update` handle.
#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// The state machine. `P` is the release handle kept for `install`
/// (`tauri_plugin_updater::Update`; tests use a plain value).
struct Slot<P> {
    state: UpdateState,
    /// Bumped by every check, so a late answer never writes over a newer one.
    generation: u64,
    pending: Option<P>,
    /// The verified archive while `ready`, until `apply` takes it.
    bytes: Option<Vec<u8>>,
    /// The user already agreed to restart a busy project for this download.
    forced: bool,
}

/// What `begin_install` decided.
#[derive(Debug)]
enum InstallStep<P> {
    /// Start downloading `P` (the state is now `downloading`).
    Download(u64, P),
    /// Apply the archive that is ready.
    Apply(u64, P, Vec<u8>),
    /// A download or an install is already under way: nothing new to start.
    Running,
    /// Nothing to install.
    NotAvailable,
}

impl<P: Clone> Slot<P> {
    const fn new() -> Self {
        Self {
            state: UpdateState::Idle,
            generation: 0,
            pending: None,
            bytes: None,
            forced: false,
        }
    }

    /// An update is being fetched or applied: a check would throw it away.
    fn in_flight(&self) -> bool {
        matches!(
            self.state,
            UpdateState::Checking | UpdateState::Downloading { .. } | UpdateState::Ready { .. }
        )
    }

    fn begin_check(&mut self) -> Option<u64> {
        if self.in_flight() {
            return None;
        }
        self.generation += 1;
        self.state = UpdateState::Checking;
        self.pending = None;
        self.bytes = None;
        self.forced = false;
        Some(self.generation)
    }

    fn finish_check(&mut self, generation: u64, outcome: Result<Option<(P, Release)>, CodedError>) {
        if generation != self.generation || self.state != UpdateState::Checking {
            return;
        }
        self.state = match outcome {
            Ok(None) => UpdateState::UpToDate,
            Ok(Some((handle, release))) => {
                self.pending = Some(handle);
                UpdateState::Available {
                    version: release.version,
                    notes: release.notes,
                    date: release.date,
                }
            }
            Err(err) => UpdateState::failed(&err),
        };
    }

    fn begin_install(&mut self, force: bool) -> InstallStep<P> {
        match &self.state {
            UpdateState::Available { version, .. } => {
                let Some(handle) = self.pending.clone() else {
                    return InstallStep::NotAvailable;
                };
                self.state = UpdateState::Downloading {
                    version: version.clone(),
                    downloaded: 0,
                    total: None,
                };
                self.forced = force;
                InstallStep::Download(self.generation, handle)
            }
            UpdateState::Downloading { .. } => {
                self.forced |= force;
                InstallStep::Running
            }
            UpdateState::Ready { version, .. } => {
                let version = version.clone();
                match (self.bytes.take(), self.pending.clone()) {
                    (Some(bytes), Some(handle)) => {
                        self.state = UpdateState::Ready {
                            version,
                            restarting: true,
                        };
                        InstallStep::Apply(self.generation, handle, bytes)
                    }
                    // Taken by an `apply` that is running now.
                    _ => InstallStep::Running,
                }
            }
            _ => InstallStep::NotAvailable,
        }
    }

    fn progress(&mut self, generation: u64, chunk: u64, total: Option<u64>) {
        if generation != self.generation {
            return;
        }
        if let UpdateState::Downloading {
            downloaded,
            total: known,
            ..
        } = &mut self.state
        {
            *downloaded += chunk;
            if total.is_some() {
                *known = total;
            }
        }
    }

    /// The download ended. When it succeeded, the archive is handed out to
    /// apply right away, with whether the user already agreed to restart a busy project.
    fn finish_download(
        &mut self,
        generation: u64,
        outcome: Result<Vec<u8>, CodedError>,
    ) -> Option<(bool, Vec<u8>)> {
        if generation != self.generation {
            return None;
        }
        let UpdateState::Downloading { version, .. } = &self.state else {
            return None;
        };
        match outcome {
            Ok(bytes) => {
                self.state = UpdateState::Ready {
                    version: version.clone(),
                    restarting: true,
                };
                Some((self.forced, bytes))
            }
            Err(err) => {
                self.state = UpdateState::failed(&err);
                self.pending = None;
                None
            }
        }
    }

    /// `apply` stopped before installing (the project became busy): keep the
    /// archive so the next `install` applies it.
    fn park(&mut self, generation: u64, bytes: Vec<u8>) {
        if generation != self.generation {
            return;
        }
        if let UpdateState::Ready { restarting, .. } = &mut self.state {
            *restarting = false;
            self.bytes = Some(bytes);
            self.forced = false;
        }
    }

    fn install_failed(&mut self, generation: u64, err: &CodedError) {
        if generation == self.generation {
            self.state = UpdateState::failed(err);
            self.pending = None;
            self.bytes = None;
        }
    }
}

static SLOT: Mutex<Slot<Update>> = Mutex::new(Slot::new());
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn slot() -> MutexGuard<'static, Slot<Update>> {
    SLOT.lock().unwrap_or_else(|e| e.into_inner())
}

/// Called once in `setup`: the routes and the menu reach the app through it.
pub fn init(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

fn app() -> Option<tauri::AppHandle> {
    APP.get().cloned()
}

pub fn state() -> UpdateState {
    slot().state.clone()
}

// ── Errors ───────────────────────────────────────────────────────────────────

fn unsupported() -> CodedError {
    CodedError::plain(
        "update_unsupported",
        "updates work only in the installed OpenVids app",
    )
}

fn check_error(err: &tauri_plugin_updater::Error) -> CodedError {
    use tauri_plugin_updater::Error as E;
    match err {
        E::FailedToDetermineExtractPath | E::UnsupportedArch | E::UnsupportedOs => unsupported(),
        other => CodedError::new(
            "update_check_failed",
            format!("could not check for updates: {other}"),
            json!({ "detail": other.to_string() }),
        ),
    }
}

/// A download error: a signature that does not verify is told apart from a network failure.
fn download_error(err: &tauri_plugin_updater::Error) -> CodedError {
    use tauri_plugin_updater::Error as E;
    match err {
        E::Minisign(_)
        | E::Base64(_)
        | E::SignatureUtf8(_)
        | E::SignedVersionMismatch { .. }
        | E::MissingSignedVersion => CodedError::new(
            "update_signature_invalid",
            "the update’s signature did not verify, so it was not installed",
            json!({ "detail": err.to_string() }),
        ),
        other => CodedError::new(
            "update_download_failed",
            format!("could not download the update: {other}"),
            json!({ "detail": other.to_string() }),
        ),
    }
}

fn install_error(detail: &str) -> CodedError {
    CodedError::new(
        "update_install_failed",
        format!("could not install the update: {detail}"),
        json!({ "detail": detail }),
    )
}

pub fn not_available() -> CodedError {
    CodedError::plain("update_not_available", "there is no update to install")
}

/// Work in the open project that a restart would cut short.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Activity {
    pub renders: u64,
    pub agent_turn: bool,
}

impl Activity {
    pub fn busy(&self) -> bool {
        self.renders > 0 || self.agent_turn
    }

    /// The Studio server's `GET /api/projects/:id/activity` answer.
    pub fn parse(body: &Value) -> Option<Self> {
        Some(Self {
            renders: body.get("renders")?.as_u64()?,
            agent_turn: body.get("agentTurn")?.as_bool()?,
        })
    }

    pub fn busy_error(&self) -> CodedError {
        CodedError::new(
            "update_busy",
            "the open project is still rendering or running an agent turn",
            json!({ "renders": self.renders, "agentTurn": self.agent_turn }),
        )
    }
}

// ── Check ────────────────────────────────────────────────────────────────────

/// Start a check (or report the one under way); answers the state right after.
pub fn check() -> UpdateState {
    let Some(app) = app() else {
        return UpdateState::failed(&unsupported());
    };
    let generation = {
        let mut slot = slot();
        match slot.begin_check() {
            Some(generation) => generation,
            None => return slot.state.clone(),
        }
    };
    tauri::async_runtime::spawn(async move {
        let outcome = find_update(&app).await;
        slot().finish_check(generation, outcome);
    });
    state()
}

async fn find_update(app: &tauri::AppHandle) -> Result<Option<(Update, Release)>, CodedError> {
    let updater = app
        .updater_builder()
        .version_comparator(|current, release| is_newer(&current, &release.version))
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| check_error(&e))?;
    let Some(update) = updater.check().await.map_err(|e| check_error(&e))? else {
        return Ok(None);
    };
    let notes = update
        .body
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(NOTES_LIMIT).collect());
    let date = update
        .raw_json
        .get("pub_date")
        .and_then(Value::as_str)
        .map(str::to_string);
    let release = Release {
        version: update.version.clone(),
        notes,
        date,
    };
    Ok(Some((update, release)))
}

/// The automatic check: once, a little after launch, when the preference says so.
/// Nothing is downloaded; the Projects page shows a mark when a version is available.
pub fn schedule_auto_check() {
    std::thread::spawn(|| {
        std::thread::sleep(AUTO_CHECK_DELAY);
        let preferences = prefs::load(&prefs::prefs_path());
        if prefs::auto_check_updates(&preferences) {
            check();
        }
    });
}

// ── Install ──────────────────────────────────────────────────────────────────

/// Why `install` did not start.
#[derive(Debug)]
pub enum Refusal {
    NotAvailable,
    Busy(Activity),
}

impl Refusal {
    pub fn error(&self) -> CodedError {
        match self {
            Self::NotAvailable => not_available(),
            Self::Busy(activity) => activity.busy_error(),
        }
    }
}

/// Download, verify, install and restart. Without `force`, a project that is
/// rendering or running an agent turn refuses with `Busy` first.
pub fn install(force: bool) -> Result<UpdateState, Refusal> {
    let Some(app) = app() else {
        return Err(Refusal::NotAvailable);
    };
    let installable = matches!(
        state(),
        UpdateState::Available { .. } | UpdateState::Downloading { .. } | UpdateState::Ready { .. }
    );
    if !installable {
        return Err(Refusal::NotAvailable);
    }
    if !force {
        if let Some(activity) = project_activity(&app).filter(Activity::busy) {
            return Err(Refusal::Busy(activity));
        }
    }
    let step = slot().begin_install(force);
    match step {
        InstallStep::Download(generation, update) => {
            tauri::async_runtime::spawn(download(app, generation, update));
        }
        InstallStep::Apply(generation, update, bytes) => {
            std::thread::spawn(move || apply(&app, generation, update, bytes, true));
        }
        InstallStep::Running => {}
        InstallStep::NotAvailable => return Err(Refusal::NotAvailable),
    }
    Ok(state())
}

async fn download(app: tauri::AppHandle, generation: u64, update: Update) {
    let outcome = update
        .download(
            |chunk, total| slot().progress(generation, chunk as u64, total),
            || {},
        )
        .await
        .map_err(|e| download_error(&e));
    let ready = slot().finish_download(generation, outcome);
    if let Some((forced, bytes)) = ready {
        std::thread::spawn(move || apply(&app, generation, update, bytes, forced));
    }
}

/// Stop what the app owns, install the verified update, restart. Runs on a
/// plain thread. `forced`: the user already agreed to restart a busy project,
/// or the caller just found it idle.
fn apply(app: &tauri::AppHandle, generation: u64, update: Update, bytes: Vec<u8>, forced: bool) {
    if !forced && project_activity(app).is_some_and(|activity| activity.busy()) {
        slot().park(generation, bytes);
        // Busy means a project is showing: ask in a native dialog.
        restart_busy_project_if_confirmed();
        return;
    }
    // Before the installer runs: on Windows it cannot overwrite the files a
    // running process holds open, so everything the app owns is already down.
    crate::release_for_update(app);
    #[cfg(unix)]
    apply_unix(app, generation, &update, &bytes);
    #[cfg(windows)]
    apply_windows(generation, &update, &bytes);
}

/// macOS: swap the `.app` bundle in place, then relaunch it from outside this
/// process (see `relaunch_after_exit`).
#[cfg(unix)]
fn apply_unix(app: &tauri::AppHandle, generation: u64, update: &Update, bytes: &[u8]) {
    match update.install(bytes) {
        Ok(()) => {
            eprintln!("[openvids] update {} installed, restarting", update.version);
            crate::logfile::shell(&format!("update {} installed, restarting", update.version));
            match relaunch_after_exit() {
                Ok(()) => app.exit(0),
                Err(err) => {
                    eprintln!("[openvids] could not relaunch through LaunchServices ({err}); restarting in place");
                    crate::logfile::shell(&format!(
                        "could not relaunch through LaunchServices ({err}); restarting in place"
                    ));
                    app.request_restart();
                }
            }
        }
        Err(err) => {
            let err = install_error(&err.to_string());
            eprintln!("[openvids] {err}");
            crate::logfile::shell(&err.to_string());
            slot().install_failed(generation, &err);
        }
    }
}

/// Windows: hand the verified package to the updater plugin, which writes the
/// NSIS installer to a temp file and spawns it in passive mode (`/P /UPDATE`,
/// relaunching the app itself through `/R`), then exits this process. A
/// success never returns, so there is nothing left to relaunch here; a
/// failure returns and lands in `failed` like everywhere else.
#[cfg(windows)]
fn apply_windows(generation: u64, update: &Update, bytes: &[u8]) {
    eprintln!("[openvids] installing update {}", update.version);
    if let Err(err) = update.install(bytes) {
        let err = install_error(&err.to_string());
        eprintln!("[openvids] {err}");
        slot().install_failed(generation, &err);
    }
}

/// How long the relauncher waits for this process to exit before it opens the app anyway.
#[cfg(unix)]
const RELAUNCH_WAIT_TENTHS: u32 = 300;

/// Open the new bundle through LaunchServices once this process has exited.
///
/// Not `AppHandle::restart`: that execs the binary as our child, so its window
/// does not come to the front and macOS attributes its file access to the old,
/// replaced binary (both seen in the manual run). A detached `/bin/sh` waits for
/// our pid to go and runs `open`, the same as launching the app from Finder.
#[cfg(unix)]
fn relaunch_after_exit() -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let exe = std::env::current_exe()?;
    let bundle = exe
        .ancestors()
        .find(|p| p.extension().is_some_and(|ext| ext == "app"))
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "not inside an .app bundle")
        })?;
    let script = format!(
        "i=0; while /bin/kill -0 \"$1\" 2>/dev/null && [ $i -lt {RELAUNCH_WAIT_TENTHS} ]; do /bin/sleep 0.1; i=$((i+1)); done; exec /usr/bin/open \"$2\""
    );
    Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .arg("openvids-relaunch")
        .arg(std::process::id().to_string())
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Its own group: nothing that reaps our groups on the way out reaches it.
        .process_group(0)
        .spawn()
        .map(drop)
}

#[cfg(not(any(unix, windows)))]
fn relaunch_after_exit() -> std::io::Result<()> {
    Err(std::io::ErrorKind::Unsupported.into())
}

// ── The open project's activity ──────────────────────────────────────────────

fn project_activity(app: &tauri::AppHandle) -> Option<Activity> {
    let (origin, id) = crate::open_project_scope(app)?;
    let path = format!("/api/projects/{}/activity", super::sidecar::urlencode(&id));
    let body = loopback_get_json(&origin, &path)?;
    Activity::parse(&body)
}

/// A small blocking GET against the loopback Studio server. `None` on any
/// failure: an unreachable server has nothing running that a restart could cut.
fn loopback_get_json(origin: &str, path: &str) -> Option<Value> {
    let authority = origin.strip_prefix("http://")?;
    let port: u16 = authority.rsplit_once(':')?.1.parse().ok()?;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .ok()?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut out = Vec::new();
    stream.read_to_end(&mut out).ok()?;
    let split = out.windows(4).position(|w| w == b"\r\n\r\n")? + 4;
    let head = String::from_utf8_lossy(&out[..split]).to_ascii_lowercase();
    if !head.lines().next().unwrap_or("").contains(" 200") {
        return None;
    }
    let body = if head.contains("transfer-encoding: chunked") {
        super::thumbnails::decode_chunked(&out[split..])?
    } else {
        out[split..].to_vec()
    };
    serde_json::from_slice(&body).ok()
}

// ── Native menu path ─────────────────────────────────────────────────────────

/// App menu › Check for Updates… while a project is showing: native dialogs,
/// so the project stays open. (On the Projects page `lib.rs` opens Settings.)
pub fn menu_check() {
    std::thread::spawn(|| match state() {
        UpdateState::Downloading {
            version,
            downloaded,
            total,
        } => {
            let percent = total
                .filter(|t| *t > 0)
                .map(|t| (downloaded.saturating_mul(100) / t).min(100))
                .unwrap_or(0)
                .to_string();
            message(
                &i18n::t_with("dialog.update.downloading.title", &[("version", &version)]),
                &i18n::t_with(
                    "dialog.update.downloading.message",
                    &[("percent", &percent)],
                ),
            );
        }
        UpdateState::Ready { .. } => install_from_dialog(),
        _ => {
            check();
            match wait_for_check() {
                UpdateState::UpToDate => message(
                    &i18n::t("dialog.update.upToDate.title"),
                    &i18n::t_with(
                        "dialog.update.upToDate.message",
                        &[("version", CURRENT_VERSION)],
                    ),
                ),
                UpdateState::Available { version, notes, .. } => {
                    let install = i18n::t("dialog.update.install");
                    let answer = rfd::MessageDialog::new()
                        .set_level(rfd::MessageLevel::Info)
                        .set_title(i18n::t_with(
                            "dialog.update.available.title",
                            &[("version", &version)],
                        ))
                        .set_description(
                            i18n::t_with(
                                "dialog.update.available.message",
                                &[
                                    ("current", CURRENT_VERSION),
                                    ("notes", notes.as_deref().unwrap_or("")),
                                ],
                            )
                            .trim_end(),
                        )
                        .set_buttons(rfd::MessageButtons::OkCancelCustom(
                            install.clone(),
                            i18n::t("dialog.update.later"),
                        ))
                        .show();
                    if answer == rfd::MessageDialogResult::Custom(install) {
                        install_from_dialog();
                    }
                }
                UpdateState::Failed {
                    error,
                    code,
                    params,
                } => show_error(&CodedError {
                    code,
                    message: error,
                    params,
                }),
                // Still checking after the wait, or another path moved on: the page shows it.
                _ => {}
            }
        }
    });
}

fn wait_for_check() -> UpdateState {
    let deadline = Instant::now() + CHECK_TIMEOUT + Duration::from_secs(5);
    loop {
        let now = state();
        if now != UpdateState::Checking || Instant::now() >= deadline {
            return now;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn install_from_dialog() {
    match install(false) {
        Ok(_) => {}
        Err(Refusal::Busy(_)) => restart_busy_project_if_confirmed(),
        Err(refusal) => show_error(&refusal.error()),
    }
}

/// Ask before restarting a project that is rendering or running an agent
/// turn; on yes, install without asking again.
fn restart_busy_project_if_confirmed() {
    if confirm_busy_restart() {
        if let Err(refusal) = install(true) {
            show_error(&refusal.error());
        }
    }
}

fn confirm_busy_restart() -> bool {
    let restart = i18n::t("dialog.update.busy.restart");
    let answer = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title(i18n::t("dialog.update.busy.title"))
        .set_description(i18n::t("dialog.update.busy.message"))
        .set_buttons(rfd::MessageButtons::OkCancelCustom(
            restart.clone(),
            i18n::t("dialog.update.busy.cancel"),
        ))
        .show();
    answer == rfd::MessageDialogResult::Custom(restart)
}

fn message(title: &str, description: &str) {
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Info)
        .set_title(title)
        .set_description(description)
        .set_buttons(rfd::MessageButtons::OkCustom(i18n::t("dialog.update.ok")))
        .show();
}

fn show_error(err: &CodedError) {
    let text = localized(err);
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title(i18n::t("dialog.update.failed.title"))
        .set_description(&text)
        .set_buttons(rfd::MessageButtons::OkCustom(i18n::t("dialog.update.ok")))
        .show();
}

/// `home.error.<code>` in the active language with the params filled in, else the English sentence.
fn localized(err: &CodedError) -> String {
    let Some(code) = err.code else {
        return err.message.clone();
    };
    let key = format!("home.error.{code}");
    let message = i18n::t(&key);
    if message == key {
        return err.message.clone();
    }
    let values: Vec<(String, String)> = err
        .params
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        v.as_str().map_or_else(|| v.to_string(), str::to_string),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let args: Vec<(&str, &str)> = values
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let text = i18n::substitute(&message, &args);
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> semver::Version {
        semver::Version::parse(text).expect("test version parses")
    }

    #[test]
    fn newer_is_strict_semver_precedence() {
        assert!(is_newer(&v("0.1.0"), &v("0.1.1")));
        assert!(is_newer(&v("0.9.9"), &v("0.10.0")), "numeric, not lexical");
        assert!(is_newer(&v("0.1.9"), &v("1.0.0")));
        assert!(
            !is_newer(&v("0.1.1"), &v("0.1.1")),
            "the same version is not an update"
        );
        assert!(!is_newer(&v("0.2.0"), &v("0.1.9")), "never a downgrade");
        assert!(
            is_newer(&v("1.0.0-rc.1"), &v("1.0.0")),
            "the release follows its pre-release"
        );
        assert!(!is_newer(&v("1.0.0"), &v("1.0.0-rc.9")));
        assert!(is_newer(&v("1.0.0-rc.1"), &v("1.0.0-rc.2")));
        assert!(
            !is_newer(&v("1.0.0+a"), &v("1.0.0+b")),
            "build metadata does not count"
        );
    }

    fn release(version: &str) -> Release {
        Release {
            version: version.into(),
            notes: Some("Fixes".into()),
            date: Some("2026-10-02T10:00:00Z".into()),
        }
    }

    #[test]
    fn a_check_ends_up_to_date_available_or_failed_and_a_late_answer_is_ignored() {
        let mut slot: Slot<&str> = Slot::new();
        let first = slot.begin_check().expect("idle can check");
        assert_eq!(slot.state, UpdateState::Checking);
        assert_eq!(
            slot.begin_check(),
            None,
            "a running check is joined, not restarted"
        );
        slot.finish_check(first, Ok(None));
        assert_eq!(slot.state, UpdateState::UpToDate);

        let second = slot.begin_check().expect("up to date can check again");
        slot.finish_check(first, Ok(Some(("stale", release("9.9.9")))));
        assert_eq!(
            slot.state,
            UpdateState::Checking,
            "an older check's answer is dropped"
        );
        slot.finish_check(second, Ok(Some(("u", release("0.1.1")))));
        assert_eq!(
            slot.state,
            UpdateState::Available {
                version: "0.1.1".into(),
                notes: Some("Fixes".into()),
                date: Some("2026-10-02T10:00:00Z".into()),
            }
        );

        let third = slot.begin_check().expect("available can re-check");
        slot.finish_check(third, Err(not_available()));
        assert!(matches!(
            slot.state,
            UpdateState::Failed {
                code: Some("update_not_available"),
                ..
            }
        ));
        assert_eq!(slot.pending, None, "a failed check forgets the old release");
    }

    #[test]
    fn install_downloads_then_applies_once_and_checks_wait_until_it_is_done() {
        let mut slot: Slot<&str> = Slot::new();
        assert!(matches!(
            slot.begin_install(false),
            InstallStep::NotAvailable
        ));
        let generation = slot.begin_check().unwrap();
        slot.finish_check(generation, Ok(Some(("u", release("0.1.1")))));

        let InstallStep::Download(download_generation, handle) = slot.begin_install(false) else {
            panic!("available starts a download");
        };
        assert_eq!((download_generation, handle), (generation, "u"));
        assert!(
            matches!(slot.begin_install(true), InstallStep::Running),
            "a second press joins"
        );
        assert!(
            slot.forced,
            "a confirmed restart carries over to the running download"
        );
        assert_eq!(slot.begin_check(), None, "no check while downloading");

        slot.progress(generation, 100, Some(1000));
        slot.progress(generation, 150, None);
        assert_eq!(
            slot.state,
            UpdateState::Downloading {
                version: "0.1.1".into(),
                downloaded: 250,
                total: Some(1000)
            }
        );
        let (forced, bytes) = slot
            .finish_download(generation, Ok(vec![1, 2, 3]))
            .expect("a finished download is handed out to apply");
        assert!(forced);
        assert_eq!(bytes, vec![1, 2, 3]);
        assert_eq!(
            slot.state,
            UpdateState::Ready {
                version: "0.1.1".into(),
                restarting: true
            }
        );
        assert_eq!(
            slot.begin_check(),
            None,
            "no check while an update is ready"
        );
        assert!(
            matches!(slot.begin_install(false), InstallStep::Running),
            "applied only once"
        );

        // The project turned busy and the user said Cancel: the archive waits.
        slot.park(generation, bytes);
        assert!(!slot.forced);
        assert_eq!(
            slot.state,
            UpdateState::Ready {
                version: "0.1.1".into(),
                restarting: false
            }
        );
        let InstallStep::Apply(_, handle, bytes) = slot.begin_install(false) else {
            panic!("a parked archive applies on the next press");
        };
        assert_eq!((handle, bytes), ("u", vec![1, 2, 3]));
        assert!(matches!(
            slot.state,
            UpdateState::Ready {
                restarting: true,
                ..
            }
        ));
        assert!(matches!(slot.begin_install(false), InstallStep::Running));
    }

    #[test]
    fn a_failed_download_or_install_ends_failed_with_its_code() {
        let mut slot: Slot<&str> = Slot::new();
        let generation = slot.begin_check().unwrap();
        slot.finish_check(generation, Ok(Some(("u", release("0.1.1")))));
        slot.begin_install(false);
        let bad = download_error(&tauri_plugin_updater::Error::SignatureUtf8("x".into()));
        assert_eq!(slot.finish_download(generation, Err(bad)), None);
        assert!(matches!(
            slot.state,
            UpdateState::Failed {
                code: Some("update_signature_invalid"),
                ..
            }
        ));
        assert!(matches!(
            slot.begin_install(false),
            InstallStep::NotAvailable
        ));

        let generation = slot.begin_check().expect("failed can check again");
        slot.finish_check(generation, Ok(Some(("u", release("0.1.1")))));
        slot.begin_install(true);
        let (_, bytes) = slot
            .finish_download(generation, Ok(vec![9]))
            .expect("ready");
        assert_eq!(bytes, vec![9]);
        slot.install_failed(generation, &install_error("disk full"));
        assert!(matches!(
            slot.state,
            UpdateState::Failed {
                code: Some("update_install_failed"),
                ..
            }
        ));
        assert!(
            slot.begin_check().is_some(),
            "a failed install can be checked again"
        );
    }

    #[test]
    fn signature_errors_are_told_apart_from_network_errors() {
        use tauri_plugin_updater::Error as E;
        for err in [
            E::SignatureUtf8("x".into()),
            E::MissingSignedVersion,
            E::SignedVersionMismatch {
                signed: "0.1.0".into(),
                announced: "0.1.1".into(),
            },
        ] {
            assert_eq!(
                download_error(&err).code,
                Some("update_signature_invalid"),
                "{err}"
            );
        }
        assert_eq!(
            download_error(&E::Network("status 404".into())).code,
            Some("update_download_failed")
        );
        assert_eq!(
            check_error(&E::FailedToDetermineExtractPath).code,
            Some("update_unsupported")
        );
        assert_eq!(
            check_error(&E::ReleaseNotFound).code,
            Some("update_check_failed")
        );
    }

    #[test]
    fn the_pages_get_a_flat_state_with_the_current_version() {
        let json = UpdateState::Downloading {
            version: "0.1.1".into(),
            downloaded: 5,
            total: None,
        }
        .to_json();
        assert_eq!(
            json,
            json!({ "phase": "downloading", "version": "0.1.1", "downloaded": 5, "total": null, "currentVersion": CURRENT_VERSION })
        );
        assert_eq!(UpdateState::UpToDate.to_json()["phase"], "upToDate");
        let failed = UpdateState::failed(&install_error("boom")).to_json();
        assert_eq!(failed["code"], "update_install_failed");
        assert_eq!(failed["params"]["detail"], "boom");
    }

    #[test]
    fn activity_is_busy_with_a_render_or_an_agent_turn() {
        let idle = Activity::parse(&json!({ "renders": 0, "agentTurn": false })).unwrap();
        assert!(!idle.busy());
        assert!(
            Activity::parse(&json!({ "renders": 2, "agentTurn": false }))
                .unwrap()
                .busy()
        );
        assert!(Activity::parse(&json!({ "renders": 0, "agentTurn": true }))
            .unwrap()
            .busy());
        assert_eq!(Activity::parse(&json!({ "error": "not found" })), None);
    }
    #[test]
    fn manifest_targets_pick_the_build_and_its_entry() {
        // The plugin tries `{base}-{bundle}` before `{base}`; the NSIS build
        // wins as soon as it is there.
        assert_eq!(
            candidate_targets("windows-x86_64", Some("nsis")),
            vec!["windows-x86_64-nsis", "windows-x86_64"]
        );
        assert_eq!(
            candidate_targets("darwin-aarch64", Some("app")),
            vec!["darwin-aarch64-app", "darwin-aarch64"]
        );
        assert_eq!(
            candidate_targets("windows-x86_64", None),
            vec!["windows-x86_64"]
        );
        assert_eq!(
            candidate_targets("windows-x86_64", Some("")),
            vec!["windows-x86_64"]
        );

        let manifest = json!({
            "version": "0.3.0",
            "notes": "  Fixes  ",
            "pub_date": "2026-10-02T10:00:00Z",
            "platforms": {
                "darwin-aarch64": { "url": "https://example.invalid/mac.tar.gz", "signature": "macsig" },
                "windows-x86_64": { "url": "https://example.invalid/OpenVids_0.3.0_x64-setup.exe", "signature": "winsig" },
            }
        });
        let candidates = candidate_targets("windows-x86_64", Some("nsis"));
        assert_eq!(
            select_platform_key(&manifest, &candidates).as_deref(),
            Some("windows-x86_64"),
            "falls back to the base entry when no -nsis one is published"
        );
        let manifest = json!({
            "version": "0.3.0",
            "platforms": {
                "windows-x86_64-nsis": { "url": "https://example.invalid/nsis.exe", "signature": "nsissig" },
                "windows-x86_64": { "url": "https://example.invalid/other.exe", "signature": "othersig" },
            }
        });
        assert_eq!(
            select_platform_key(&manifest, &candidates).as_deref(),
            Some("windows-x86_64-nsis"),
            "prefers the bundle-qualified entry when published"
        );
        assert_eq!(
            select_platform_key(&manifest, &["darwin-aarch64".to_string()]),
            None,
            "a windows-only manifest has nothing for the macOS build"
        );
    }

    #[test]
    fn a_static_manifest_with_a_windows_entry_parses_for_that_target() {
        let manifest = json!({
            "version": "0.3.0",
            "notes": "  Fixes and more  ",
            "pub_date": "2026-10-02T10:00:00Z",
            "platforms": {
                "darwin-aarch64": {
                    "url": "https://example.invalid/OpenVids_0.3.0_aarch64.app.tar.gz",
                    "signature": "macsig"
                },
                "windows-x86_64": {
                    "url": "https://example.invalid/OpenVids_0.3.0_x64-setup.exe",
                    "signature": "winsig"
                },
            }
        });
        let release =
            parse_manifest_release(&manifest, "windows-x86_64").expect("the windows entry parses");
        assert_eq!(release.version, "0.3.0");
        assert_eq!(release.notes.as_deref(), Some("Fixes and more"));
        assert_eq!(release.date.as_deref(), Some("2026-10-02T10:00:00Z"));
        assert!(release.url.ends_with("-setup.exe"));
        assert_eq!(release.signature, "winsig");
        assert!(
            is_newer(&v("0.2.0"), &v(&release.version)),
            "the parsed version compares newer than the last release"
        );
        assert_eq!(parse_manifest_release(&manifest, "linux-x86_64"), None);
        assert_eq!(
            parse_manifest_release(&json!({ "version": "0.3.0" }), "windows-x86_64"),
            None,
            "no platforms and no top-level url: nothing to download"
        );
    }

    #[test]
    fn a_dynamic_manifest_parses_without_a_platforms_map() {
        let manifest = json!({
            "version": "0.3.0",
            "notes": "",
            "pub_date": "2026-10-02T10:00:00Z",
            "url": "https://example.invalid/OpenVids_0.3.0_x64-setup.exe",
            "signature": "winsig"
        });
        let release = parse_manifest_release(&manifest, "windows-x86_64")
            .expect("a server-resolved manifest parses");
        assert_eq!(
            release.url,
            "https://example.invalid/OpenVids_0.3.0_x64-setup.exe"
        );
        assert_eq!(release.notes, None, "blank notes stay blank");
    }

    #[test]
    fn the_plugin_target_matches_the_release_manifest_key() {
        let Some(target) = update_target() else {
            panic!("the updater plugin knows this build's target");
        };
        assert!(
            !target.is_empty() && target.contains('-'),
            "a `{{os}}-{{arch}}` key, got {target:?}"
        );
        if cfg!(windows) {
            assert_eq!(target, "windows-x86_64");
            assert_eq!(
                candidate_targets(&target, Some("nsis"))[1],
                "windows-x86_64",
                "the fallback key the release manifest must carry"
            );
        } else if cfg!(target_os = "macos") {
            assert!(
                target == "darwin-aarch64" || target == "darwin-x86_64",
                "unexpected macOS target {target:?}"
            );
        }
    }
}
