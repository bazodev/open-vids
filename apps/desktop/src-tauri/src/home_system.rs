//! The first-run System check routes (`/api/system/*`, token-gated like every
//! `/api/` route).
//!
//! - `GET /api/system/check` — what a render needs: Chrome, FFmpeg, FFprobe.
//!   Asked of the CLI (`hyperframes doctor --tools`, side-effect free, ~0.3 s;
//!   10 s at most) so detection stays in one place. Answer:
//!   `{platform, arch, chrome, ffmpeg, ffprobe, install: {chrome}}` where each
//!   tool is `{found, path, version, source, canInstall}` (`source`:
//!   `"openvids"` installed under OpenVids' own directories, `"system"`,
//!   `"env"` a `HYPERFRAMES_*_PATH` override; all `null` when not found) and
//!   Chrome also has `systemPath` (a system Chrome that exists but that
//!   rendering does not use). `canInstall` is whether this build offers an
//!   install button for it. A CLI that cannot be run answers 503 `{error}`.
//! - `GET /api/system/install/chrome` — the install state (`chrome_install`).
//! - `POST /api/system/install/chrome` — start it (or join the running one);
//!   answers the state.
//! - `POST /api/system/install/chrome/cancel` — cancel it; answers the state.
//! - `GET|POST /api/system/install/ffmpeg`, `POST …/ffmpeg/cancel` — the same
//!   three for FFmpeg (`ffmpeg_install`). On macOS it runs Homebrew and the
//!   state carries `detail` (brew's current output line) instead of byte
//!   counts; `POST` answers 409 `{error}` when Homebrew is not installed. On
//!   Windows it downloads the official build into `~/.openvids/ffmpeg` with
//!   byte progress, and `POST` always starts it.
//!
//! The check also carries `homebrew: {found, path, installCommand, note, url}`
//! (macOS only; `found` is false elsewhere). `ffmpeg`/`ffprobe` have
//! `canInstall` and `installer` (`"homebrew"` when Homebrew is there and the
//! tool is missing, `"download"` when the Windows build is missing, else `null`).

use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use super::coded_error::CodedError;
use super::home_api::{method_not_allowed, respond_error, respond_json, route_not_found};
use super::install_job::InstallState;
use super::{chrome_install, cli_runner, ffmpeg_install, prefs};

const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

pub fn owns(path: &str) -> bool {
    path.starts_with("/api/system/")
}

/// The CLI's managed Chrome cache.
fn managed_chrome_cache() -> std::path::PathBuf {
    prefs::home_dir().join(".cache").join("hyperframes")
}

/// `openvids` / `env` / `system` for a path found by the CLI.
pub fn classify_source(path: &str, env_override: Option<&str>, roots: &[&Path]) -> &'static str {
    if env_override.is_some_and(|o| !o.trim().is_empty() && Path::new(o.trim()) == Path::new(path)) {
        return "env";
    }
    if roots.iter().any(|root| Path::new(path).starts_with(root)) {
        return "openvids";
    }
    "system"
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

/// One tool of the CLI's `tools` object, as the page gets it. `installer` is
/// the installer the button would use (`canInstall` is true exactly when it is `Some`).
fn tool_json(
    raw: &Value,
    source: impl Fn(&str, Option<&str>) -> &'static str,
    installer: Option<&'static str>,
) -> Value {
    let found = raw.get("found").and_then(Value::as_bool).unwrap_or(false);
    let path = text(raw, "path").filter(|_| found);
    let cli_source = text(raw, "source");
    let source = path.as_deref().map(|p| source(p, cli_source.as_deref()));
    json!({
        "found": found,
        "path": path,
        "version": text(raw, "version").filter(|_| found),
        "source": source,
        "canInstall": installer.is_some(),
        "installer": installer,
    })
}

/// The page's answer from the CLI's `tools` object. Pure, for tests.
pub fn build_check(
    tools: &Value,
    brew: Option<&Path>,
    chrome: &InstallState,
    ffmpeg: &InstallState,
) -> Value {
    let chrome_cache = managed_chrome_cache();
    let env_of = |name: &str| std::env::var(name).ok();
    let ffmpeg_env = env_of("HYPERFRAMES_FFMPEG_PATH");
    let ffprobe_env = env_of("HYPERFRAMES_FFPROBE_PATH");
    let managed_root = ffmpeg_install::managed_dir();
    let ff_roots = [managed_root.as_path()];
    let chrome_roots = [chrome_cache.as_path()];
    let mut chrome_json = tool_json(
        tools.get("chrome").unwrap_or(&Value::Null),
        |path, cli_source| match cli_source {
            Some("env") => "env",
            _ => classify_source(path, None, &chrome_roots),
        },
        (!(cfg!(target_os = "linux") && cfg!(target_arch = "aarch64"))).then_some("download"),
    );
    chrome_json["systemPath"] = json!(tools.get("chrome").and_then(|c| text(c, "systemPath")));
    // The downloaded Windows build is one install for both tools. A previous
    // download counts as found even when the long-lived CLI has not re-run:
    // `managed_env` (what the sidecars spawn with) is the source of truth.
    let managed_ffmpeg = ffmpeg_install::managed_ffmpeg();
    let managed_ffprobe = ffmpeg_install::managed_ffprobe();
    let ff_installer = |name: &str| {
        let found = tools.get(name).and_then(|t| t.get("found")).and_then(Value::as_bool) == Some(true);
        if found {
            return None;
        }
        if cfg!(windows) {
            let managed = if name == "ffprobe" { &managed_ffprobe } else { &managed_ffmpeg };
            if managed.is_some() {
                return None;
            }
            return Some("download");
        }
        (brew.is_some()).then_some("homebrew")
    };
    json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "chrome": chrome_json,
        // FFmpeg is installed with Homebrew or not at all; one `brew install
        // ffmpeg` provides both tools. Anything not under an OpenVids-owned
        "ffmpeg": tool_json(
            tools.get("ffmpeg").unwrap_or(&Value::Null),
            |path, _| classify_source(path, ffmpeg_env.as_deref(), &ff_roots),
            ff_installer("ffmpeg"),
        ),
        "ffprobe": tool_json(
            tools.get("ffprobe").unwrap_or(&Value::Null),
            |path, _| classify_source(path, ffprobe_env.as_deref(), &ff_roots),
            ff_installer("ffprobe"),
        ),
        "homebrew": {
            "found": brew.is_some(),
            "path": brew.map(|b| b.to_string_lossy().into_owned()),
            "installCommand": ffmpeg_install::INSTALL_COMMAND,
            "note": ffmpeg_install::INSTALL_NOTE,
            "url": ffmpeg_install::BREW_URL,
        },
        "install": { "chrome": chrome, "ffmpeg": ffmpeg },
    })
}

fn handle_check(stream: &mut TcpStream) {
    let result = cli_runner::run(&["doctor", "--tools"], CHECK_TIMEOUT).and_then(|out| {
        cli_runner::last_json_line(&out)
            .and_then(|v| v.get("tools").cloned())
            .ok_or_else(|| {
                CodedError::plain("check_unreadable", "the check answered with something unreadable")
            })
    });
    match result {
        Ok(tools) => respond_json(
            stream,
            200,
            &build_check(
                &tools,
                ffmpeg_install::find_brew().as_deref(),
                &chrome_install::state(),
                &ffmpeg_install::state(),
            ),
        ),
        Err(err) => respond_error(stream, 503, &err),
    }
}

/// Handle one request for which `owns(path)` holds.
pub fn handle(stream: &mut TcpStream, method: &str, path: &str) {
    match (method, path) {
        ("GET", "/api/system/check") => handle_check(stream),
        ("GET", "/api/system/install/chrome") => respond_json(stream, 200, &json!(chrome_install::state())),
        ("POST", "/api/system/install/chrome") => respond_json(stream, 200, &json!(chrome_install::start())),
        ("POST", "/api/system/install/chrome/cancel") => {
            respond_json(stream, 200, &json!(chrome_install::cancel()))
        }
        ("GET", "/api/system/install/ffmpeg") => respond_json(stream, 200, &json!(ffmpeg_install::state())),
        ("POST", "/api/system/install/ffmpeg") => {
            if cfg!(windows) {
                // Windows has no Homebrew flow: always start the official-build download.
                respond_json(stream, 200, &json!(ffmpeg_install::start()))
            } else {
                match ffmpeg_install::find_brew() {
                    Some(_) => respond_json(stream, 200, &json!(ffmpeg_install::start())),
                    None => respond_error(stream, 409, &ffmpeg_install::homebrew_missing()),
                }
            }
        }
        ("POST", "/api/system/install/ffmpeg/cancel") => {
            respond_json(stream, 200, &json!(ffmpeg_install::cancel()))
        }
        (
            _,
            "/api/system/check"
            | "/api/system/install/chrome"
            | "/api/system/install/chrome/cancel"
            | "/api/system/install/ffmpeg"
            | "/api/system/install/ffmpeg/cancel",
        ) => respond_error(stream, 405, &method_not_allowed()),
        _ => respond_error(stream, 404, &route_not_found()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::cli_runner::tests::with_fake_cli;

    #[test]
    #[cfg(not(windows))]
    fn sources_are_told_apart_by_path_and_override() {
        let tools = Path::new("/home/u/.openvids/tools");
        assert_eq!(
            classify_source("/home/u/.openvids/tools/ffmpeg/9.0.2/ffmpeg", None, &[tools]),
            "openvids"
        );
        assert_eq!(classify_source("/opt/homebrew/bin/ffmpeg", None, &[tools]), "system");
        assert_eq!(
            classify_source("/x/my-ffmpeg", Some("/x/my-ffmpeg"), &[tools]),
            "env"
        );
        // An override that points elsewhere does not make this path "env".
        assert_eq!(classify_source("/usr/bin/ffmpeg", Some("/x/other"), &[tools]), "system");
        assert_eq!(classify_source("/usr/bin/ffmpeg", Some("  "), &[tools]), "system");
        // A sibling directory with the same prefix is not inside the root.
        assert_eq!(
            classify_source("/home/u/.openvids/tools-evil/ffmpeg", None, &[tools]),
            "system"
        );
    }

    #[test]
    #[cfg(windows)]
    fn sources_are_told_apart_by_path_and_override() {
        let tools = Path::new(r"C:\Users\u\.openvids\tools");
        assert_eq!(
            classify_source(r"C:\Users\u\.openvids\tools\ffmpeg\9.0.2\ffmpeg.exe", None, &[tools]),
            "openvids"
        );
        assert_eq!(classify_source(r"C:\ProgramData\chocolatey\bin\ffmpeg.exe", None, &[tools]), "system");
        assert_eq!(
            classify_source(r"C:\x\my-ffmpeg.exe", Some(r"C:\x\my-ffmpeg.exe"), &[tools]),
            "env"
        );
        // An override that points elsewhere does not make this path "env".
        assert_eq!(
            classify_source(r"C:\Windows\ffmpeg.exe", Some(r"C:\x\other.exe"), &[tools]),
            "system"
        );
        assert_eq!(classify_source(r"C:\Windows\ffmpeg.exe", Some("  "), &[tools]), "system");
        // A sibling directory with the same prefix is not inside the root.
        assert_eq!(
            classify_source(r"C:\Users\u\.openvids\tools-evil\ffmpeg.exe", None, &[tools]),
            "system"
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn the_cli_answer_becomes_the_pages_shape() {
        let home = prefs::home_dir();
        let managed = home.join(".cache/hyperframes/chrome/x/chrome-headless-shell");
        let tools = json!({
            "ffmpeg": {"found": true, "path": "/opt/homebrew/bin/ffmpeg", "version": "9.0.2"},
            "ffprobe": {"found": false},
            "chrome": {
                "found": true, "path": managed.to_string_lossy(), "source": "cache",
                "version": "152.0.7977.30", "systemPath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            },
        });
        let idle = InstallState::IDLE;
        let brew = Path::new("/opt/homebrew/bin/brew");
        let check = build_check(&tools, Some(brew), &idle, &idle);
        assert_eq!(check["ffmpeg"]["found"], true);
        assert_eq!(check["ffmpeg"]["source"], "system");
        assert_eq!(check["ffmpeg"]["version"], "9.0.2");
        // Installed already: nothing to install.
        assert_eq!(check["ffmpeg"]["canInstall"], false);
        assert_eq!(check["ffmpeg"]["installer"], Value::Null);
        // Missing, and Homebrew is there: the button can be offered.
        assert_eq!(
            check["ffprobe"],
            json!({"found": false, "path": null, "version": null, "source": null, "canInstall": true, "installer": "homebrew"})
        );
        assert_eq!(check["homebrew"]["found"], true);
        assert_eq!(check["homebrew"]["path"], "/opt/homebrew/bin/brew");
        assert_eq!(check["homebrew"]["installCommand"], "brew install ffmpeg");
        assert_eq!(check["homebrew"]["url"], "https://brew.sh");
        assert!(check["homebrew"]["note"].as_str().unwrap().contains("several minutes"));
        assert_eq!(check["chrome"]["source"], "openvids");
        assert_eq!(check["chrome"]["version"], "152.0.7977.30");
        assert!(check["chrome"]["systemPath"].as_str().unwrap().contains("Google Chrome"));
        assert_eq!(check["install"]["chrome"]["phase"], "idle");
        assert_eq!(check["install"]["ffmpeg"]["phase"], "idle");
        assert_eq!(check["install"]["ffmpeg"]["detail"], Value::Null);
        assert!(check["platform"].is_string() && check["arch"].is_string());

        // No Homebrew: never an install button for FFmpeg, and the command is there to show.
        let missing = build_check(&json!({}), None, &idle, &idle);
        assert_eq!(missing["chrome"]["found"], false);
        assert_eq!(missing["chrome"]["systemPath"], Value::Null);
        for tool in ["ffmpeg", "ffprobe"] {
            assert_eq!(missing[tool]["found"], false);
            assert_eq!(missing[tool]["canInstall"], false);
            assert_eq!(missing[tool]["installer"], Value::Null);
        }
        assert_eq!(missing["homebrew"]["found"], false);
        assert_eq!(missing["homebrew"]["path"], Value::Null);
        assert_eq!(missing["homebrew"]["installCommand"], "brew install ffmpeg");
    }

    #[test]
    #[cfg(windows)]
    fn the_cli_answer_becomes_the_pages_shape() {
        let _lock = super::ffmpeg_install::FFMPEG_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Windows offers the download installer for missing tools; the managed
        // Chrome cache still classifies. Isolate the managed dir so the real
        // ~/.openvids/ffmpeg on this machine cannot flip the assertions.
        let dir = std::env::temp_dir().join(format!(
            "openvids-shape-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
        ));
        std::env::set_var("OPENVIDS_FFMPEG_DIR", &dir);
        let home = prefs::home_dir();
        let managed = home.join(".cache/hyperframes/chrome/x/chrome-headless-shell.exe");
        let tools = json!({
            "ffmpeg": {"found": true, "path": "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe", "version": "7.1"},
            "ffprobe": {"found": false},
            "chrome": {
                "found": true, "path": managed.to_string_lossy(), "source": "cache",
                "version": "152.0.7977.30", "systemPath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
            },
        });
        let idle = InstallState::IDLE;
        let check = build_check(&tools, None, &idle, &idle);
        assert_eq!(check["ffmpeg"]["found"], true);
        assert_eq!(check["ffmpeg"]["source"], "system");
        assert_eq!(check["ffmpeg"]["version"], "7.1");
        assert_eq!(check["ffmpeg"]["canInstall"], false);
        assert_eq!(check["ffmpeg"]["installer"], Value::Null);
        assert_eq!(check["ffprobe"]["canInstall"], true);
        assert_eq!(check["ffprobe"]["installer"], "download");
        assert_eq!(check["homebrew"]["found"], false);
        assert_eq!(check["chrome"]["source"], "openvids");
        assert!(check["chrome"]["systemPath"].as_str().unwrap().contains("Chrome"));
        // A managed build flips the installer off: nothing left to install.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ffmpeg.exe"), "f").unwrap();
        std::fs::write(dir.join("ffprobe.exe"), "p").unwrap();
        let check = build_check(&json!({"ffmpeg": {"found": false}, "ffprobe": {"found": false}, "chrome": {"found": false}}), None, &idle, &idle);
        assert_eq!(check["ffmpeg"]["canInstall"], false);
        assert_eq!(check["ffmpeg"]["installer"], Value::Null);
        std::env::remove_var("OPENVIDS_FFMPEG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The fake CLI is a `sh` script: unix-only, like the home.rs callers.
    #[test]
    #[cfg(unix)]
    fn the_check_asks_the_cli_for_doctor_tools() {
        let script = r#"
if [ "$1" = "doctor" ] && [ "$2" = "--tools" ]; then
  echo 'a notice that is not json'
  echo '{"tools":{"ffmpeg":{"found":true,"path":"/usr/bin/ffmpeg","version":"7.1"},"ffprobe":{"found":false},"chrome":{"found":false}}}'
else
  exit 9
"#;
        let out = with_fake_cli(script, || cli_runner::run(&["doctor", "--tools"], CHECK_TIMEOUT)).unwrap();
        let tools = cli_runner::last_json_line(&out).unwrap()["tools"].clone();
        let check = build_check(&tools, None, &InstallState::IDLE, &InstallState::IDLE);
        assert_eq!(check["ffmpeg"]["path"], "/usr/bin/ffmpeg");
    }

    #[test]
    fn owns_only_system_routes() {
        assert!(owns("/api/system/check"));
        assert!(owns("/api/system/install/chrome/cancel"));
        assert!(!owns("/api/systemx"));
        assert!(!owns("/api/agent/models"));
    }
}
