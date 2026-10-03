//! Create-project handling for the home screen (`POST /api/create`).
//!
//! The template lookup order is: `OPENVids_TEST_TEMPLATES` (tests only) →
//! the production staged copy (`runtime/hyperframes/templates`, supplied by
//! the caller in `lib.rs`) → the dev checkout
//! (`packages/cli/src/templates`). See `create.rs` for what the scaffold
//! writes and what it deliberately skips from the CLI's interactive `init`.

use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use super::coded_error::CodedError;
use super::home_api::respond_error;
use super::home_routes::{begin_open, respond, HomeInner};

pub fn handle_create(stream: &mut TcpStream, state: &Arc<Mutex<HomeInner>>, body: &[u8]) {
    let params = match parse_create(body) {
        Ok(params) => params,
        Err(error) => {
            respond_error(stream, 400, &error);
            return;
        }
    };
    // The default location (`~/Documents/OpenVids` on Windows,
    // `~/Movies/OpenVids` elsewhere) may not exist yet on a
    // fresh machine; it is ours to create. Any other parent must exist.
    let prefs = super::prefs::load(&super::prefs::prefs_path());
    let defaults = super::prefs::new_project(&prefs);
    if params.parent == defaults.location {
        let _ = std::fs::create_dir_all(&params.parent);
    }
    let workspace = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("workspace")
                .and_then(|w| w.as_str())
                .map(str::to_string)
        })
        .filter(|w| super::prefs::WORKSPACES.contains(&w.as_str()))
        .unwrap_or(defaults.open_in);
    match scaffold_blank(&params) {
        Ok(dest) => {
            let name = params.name.clone();
            begin_open(state, name, dest, Some(workspace));
            respond(stream, 200, "application/json", br#"{"opening":true}"#);
        }
        Err(error) => respond_error(stream, 400, &error),
    }
}

/// Scaffold a blank project from the template this build resolves.
pub fn scaffold_blank(params: &super::create::CreateParams) -> Result<PathBuf, CodedError> {
    let staged = std::env::var("OPENVids_TEST_TEMPLATES")
        .ok()
        .map(PathBuf::from)
        .or_else(production_templates_dir);
    let index = super::create::blank_template_index(staged.as_deref())
        .ok_or_else(|| CodedError::plain("template_unavailable", "project template unavailable"))?;
    super::create::scaffold(&index, params).map_err(|err| err.coded())
}

fn parse_create(body: &[u8]) -> Result<super::create::CreateParams, CodedError> {
    let value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|_| CodedError::plain("create_body_invalid", "invalid request body"))?;
    let parent = value
        .get("parent")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| CodedError::plain("create_no_location", "choose a location first"))?;
    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CodedError::plain("create_no_name", "give the project a name"))?
        .to_string();
    let fps = value
        .get("fps")
        .and_then(|v| v.as_str())
        .unwrap_or("30")
        .to_string();
    let no_resolution = || CodedError::plain("create_no_resolution", "pick a resolution");
    let width = value
        .get("width")
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(no_resolution)?;
    let height = value
        .get("height")
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(no_resolution)?;
    let duration = value
        .get("duration")
        .and_then(|v| v.as_f64())
        .unwrap_or(10.0);
    Ok(super::create::CreateParams {
        parent: super::prefs::expand_tilde(parent),
        name,
        fps,
        width,
        height,
        duration,
    })
}

/// Production's staged template dir. The real path is only known at runtime
/// (from the bundled resources in `lib.rs`), so a write-once cell — not a
/// `LazyLock` with a fixed initializer — is the right shape here.
static STAGED_TEMPLATES: OnceLock<PathBuf> = OnceLock::new();

/// Remember the staged template dir for this process (called once at startup
/// in production; never in dev or tests, which resolve the checkout instead).
pub fn set_staged_templates(dir: PathBuf) {
    let _ = STAGED_TEMPLATES.set(dir);
}

fn production_templates_dir() -> Option<PathBuf> {
    STAGED_TEMPLATES.get().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(json: &str) -> Vec<u8> {
        json.as_bytes().to_vec()
    }

    #[test]
    #[cfg(not(windows))]
    fn parse_accepts_a_full_form() {
        let params = parse_create(&body(
            r#"{"parent":"/tmp/x","name":"my-video","fps":"24","width":1080,"height":1920,"duration":12}"#,
        ))
        .unwrap();
        assert_eq!(params.name, "my-video");
        assert_eq!(params.fps, "24");
        assert_eq!((params.width, params.height), (1080, 1920));
        assert_eq!(params.duration, 12.0);
    }

    #[test]
    #[cfg(windows)]
    fn parse_accepts_a_full_form() {
        let params = parse_create(&body(
            r#"{"parent":"C:\\tmp\\x","name":"my-video","fps":"24","width":1080,"height":1920,"duration":12}"#,
        ))
        .unwrap();
        assert_eq!(params.name, "my-video");
        assert_eq!(params.fps, "24");
        assert_eq!((params.width, params.height), (1080, 1920));
        assert_eq!(params.duration, 12.0);
        assert_eq!(params.parent, PathBuf::from(r"C:\tmp\x"));
    }

    #[test]
    #[cfg(not(windows))]
    fn parse_rejects_an_empty_name_or_size() {
        assert!(parse_create(&body(
            r#"{"parent":"/tmp/x","name":"","width":8,"height":8}"#
        ))
        .is_err());
        assert!(parse_create(&body(
            r#"{"parent":"/tmp/x","name":"ok","width":0,"height":8}"#
        ))
        .is_ok());
        // Zero sizes pass the JSON shape but fail in `scaffold` validation.
        let params = parse_create(&body(
            r#"{"parent":"/tmp/x","name":"ok","width":0,"height":8}"#,
        ))
        .unwrap();
        assert_eq!(params.width, 0);
    }

    #[test]
    #[cfg(windows)]
    fn parse_rejects_an_empty_name_or_size() {
        assert!(parse_create(&body(
            r#"{"parent":"C:\\tmp\\x","name":"","width":8,"height":8}"#
        ))
        .is_err());
        assert!(parse_create(&body(
            r#"{"parent":"C:\\tmp\\x","name":"ok","width":0,"height":8}"#
        ))
        .is_ok());
        // Zero sizes pass the JSON shape but fail in `scaffold` validation.
        let params = parse_create(&body(
            r#"{"parent":"C:\\tmp\\x","name":"ok","width":0,"height":8}"#,
        ))
        .unwrap();
        assert_eq!(params.width, 0);
    }

    #[test]
    fn parse_requires_a_parent() {
        assert!(parse_create(&body(r#"{"name":"ok","width":8,"height":8}"#)).is_err());
    }
}
