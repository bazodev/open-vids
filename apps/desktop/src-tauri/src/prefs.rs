//! App preferences shared by the Projects home and Studio.
//!
//! One JSON file, `~/.openvids/app/preferences.json` (the directory can be
//! overridden with `OPENVIDS_APP_DIR`). The studio-server serves the same file
//! at `GET/PUT /api/app/preferences`, so both sides follow the same rules:
//!
//! - a missing or unreadable file means the defaults below;
//! - known keys with an invalid value fall back to their default on read;
//! - unknown keys (written by a newer app, or by the other side) are kept —
//!   updates are a deep merge into the stored document, never a replacement;
//! - writes are atomic (temp file + rename), so a crash never leaves half a file.
//!
//! The file is re-read on every request instead of cached: Studio may have
//! changed it since the home page last looked.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

pub const THEMES: [&str; 3] = ["system", "dark", "light"];
pub const WORKSPACES: [&str; 3] = ["media", "story", "edit"];
pub const LAUNCH_MODES: [&str; 2] = ["projects", "last"];
pub const DENSITIES: [&str; 2] = ["default", "compact"];
pub const FPS_CHOICES: [u64; 4] = [24, 25, 30, 60];
const MAX_SIZE: u64 = 8192;

/// The default New Projects folder: `~/Documents/OpenVids` on Windows,
/// `~/Movies/OpenVids` elsewhere.
pub fn default_project_location() -> &'static str {
    default_project_location_for(cfg!(windows))
}

fn default_project_location_for(windows: bool) -> &'static str {
    if windows {
        "~/Documents/OpenVids"
    } else {
        "~/Movies/OpenVids"
    }
}

fn migrate_legacy_location(location: &str, windows: bool, home: &Path) -> Option<String> {
    if !windows {
        return None;
    }
    let normalized = location.replace('\\', "/").to_lowercase();
    let legacy_tilde = normalized == "~/movies/openvids";
    let legacy_expanded = std::iter::once(home.to_path_buf())
        .map(|path| path.join("Movies").join("OpenVids"))
        .any(|path| path.to_string_lossy().replace('\\', "/").to_lowercase() == normalized);
    (legacy_tilde || legacy_expanded).then(|| "~/Documents/OpenVids".to_string())
}
fn is_windows() -> bool {
    cfg!(windows)
}

fn defaults_for(windows: bool) -> Value {
    json!({
        "version": 1,
        "theme": "system",
        "language": "system",
        "newProject": {
            "location": default_project_location_for(windows),
            "openIn": "media",
            "width": 1920,
            "height": 1080,
            "fps": 24
        },
        "confirmTrash": true,
        "onLaunch": "projects",
        "density": "default",
        "updates": { "autoCheck": true },
        "telemetry": { "enabled": true },
        "onboarding": { "completedAt": null }
    })
}

/// The preferences directory: `OPENVIDS_APP_DIR`, else `~/.openvids/app`.
pub fn app_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("OPENVIDS_APP_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    home_dir().join(".openvids").join("app")
}

pub fn prefs_path() -> PathBuf {
    app_dir().join("preferences.json")
}

/// The user's home directory, resolved exactly like Node's `os.homedir()`
/// (see `platform::home_dir`): `USERPROFILE` on Windows — Node ignores `HOME`
/// there, so `~/.openvids` (preferences, the Asset Search policy) lands in
/// the same place on both sides — `$HOME` on Unix.
pub fn home_dir() -> PathBuf {
    super::platform::home_dir()
}

/// `~` and `~/…` → the user's home directory; everything else unchanged.
pub fn expand_tilde(raw: &str) -> PathBuf {
    if raw == "~" {
        return home_dir();
    }
    match raw.strip_prefix("~/") {
        Some(rest) => home_dir().join(rest),
        None => PathBuf::from(raw),
    }
}

/// The inverse of `expand_tilde` for display: `/Users/me/x` → `~/x`.
pub fn abbreviate_home(path: &Path) -> String {
    let home = home_dir();
    match path.strip_prefix(&home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => format!("~/{}", rest.to_string_lossy()),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

/// Read the stored document (unknown keys included) without validation.
fn read_raw(path: &Path) -> Value {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}

/// The effective preferences: the stored document with every known key
/// validated (invalid or missing → default), unknown keys kept.
pub fn load(path: &Path) -> Value {
    load_for(path, is_windows(), &home_dir())
}

fn load_for(path: &Path, windows: bool, home: &Path) -> Value {
    let mut stored = read_raw(path);
    let migrated = migrate_stored_location(&mut stored, windows, home);
    let effective = normalize_for(stored, windows);
    if migrated {
        let _ = write_atomic(path, &effective);
    }
    effective
}

/// Deep-merge `patch` into the stored document, validate, write atomically and
/// return the effective result. Only objects merge; any other value replaces.
pub fn update(path: &Path, patch: &Value) -> std::io::Result<Value> {
    if !patch.is_object() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "preferences must be a JSON object",
        ));
    }
    let mut stored = read_raw(path);
    migrate_stored_location(&mut stored, is_windows(), &home_dir());
    merge(&mut stored, patch);
    let effective = normalize_for(stored, is_windows());
    write_atomic(path, &effective)?;
    Ok(effective)
}

pub fn merge(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(into), Value::Object(from)) => {
            for (key, value) in from {
                match into.get_mut(key) {
                    Some(existing) if existing.is_object() && value.is_object() => {
                        merge(existing, value)
                    }
                    _ => {
                        into.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (slot, value) => *slot = value.clone(),
    }
}

fn migrate_stored_location(stored: &mut Value, windows: bool, home: &Path) -> bool {
    let Some(location) = stored["newProject"]["location"].as_str() else {
        return false;
    };
    let Some(migrated) = migrate_legacy_location(location, windows, home) else {
        return false;
    };
    stored["newProject"]["location"] = json!(migrated);
    true
}

fn normalize_for(stored: Value, windows: bool) -> Value {
    let mut out = match stored {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let base = defaults_for(windows);
    out.insert("version".into(), json!(1));
    let theme = pick_str(out.get("theme"), &THEMES, "system");
    out.insert("theme".into(), json!(theme));
    let language = pick_language(out.get("language"));
    out.insert("language".into(), json!(language));
    let launch = pick_str(out.get("onLaunch"), &LAUNCH_MODES, "projects");
    out.insert("onLaunch".into(), json!(launch));
    let confirm = out
        .get("confirmTrash")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    out.insert("confirmTrash".into(), json!(confirm));
    let density = pick_str(out.get("density"), &DENSITIES, "default");
    out.insert("density".into(), json!(density));

    // Update behaviour: whether the app checks for a new version after launch (`updater.rs`).
    let mut updates = match out.remove("updates") {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let auto_check = updates
        .get("autoCheck")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    updates.insert("autoCheck".into(), json!(auto_check));
    out.insert("updates".into(), Value::Object(updates));

    // Anonymous usage statistics (`telemetry.rs`): on unless the user turned them off.
    let mut telemetry = match out.remove("telemetry") {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let enabled = telemetry
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    telemetry.insert("enabled".into(), json!(enabled));
    out.insert("telemetry".into(), Value::Object(telemetry));

    // First-run onboarding: when it was finished (ms since the epoch), else null.
    let mut onboarding = match out.remove("onboarding") {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let completed_at = onboarding
        .get("completedAt")
        .and_then(Value::as_u64)
        .filter(|ms| *ms > 0);
    onboarding.insert("completedAt".into(), json!(completed_at));
    out.insert("onboarding".into(), Value::Object(onboarding));

    let mut np = match out.remove("newProject") {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let np_base = &base["newProject"];
    let location = np
        .get("location")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            np_base["location"]
                .as_str()
                .unwrap_or(default_project_location_for(windows))
                .to_string()
        });
    np.insert("location".into(), json!(location));
    let open_in = pick_str(np.get("openIn"), &WORKSPACES, "media");
    np.insert("openIn".into(), json!(open_in));
    let width = pick_size(np.get("width")).unwrap_or(1920);
    let height = pick_size(np.get("height")).unwrap_or(1080);
    np.insert("width".into(), json!(width));
    np.insert("height".into(), json!(height));
    let fps = np
        .get("fps")
        .and_then(Value::as_u64)
        .filter(|f| FPS_CHOICES.contains(f))
        .unwrap_or(24);
    np.insert("fps".into(), json!(fps));
    out.insert("newProject".into(), Value::Object(np));
    Value::Object(out)
}

fn pick_str(value: Option<&Value>, allowed: &[&str], fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|s| allowed.contains(s))
        .unwrap_or(fallback)
        .to_string()
}

/// The `language` preference: `"system"` or a code from `locales/index.json`.
/// Anything else (including a non-string) reads as `"system"`.
fn pick_language(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .filter(|s| *s == "system" || super::locales::LOCALE_CODES.contains(s))
        .unwrap_or("system")
        .to_string()
}

fn pick_size(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|n| (1..=MAX_SIZE).contains(n))
}

fn write_atomic(path: &Path, value: &Value) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec_pretty(value)?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "preferences.json".into()),
        std::process::id()
    ));
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Typed view of the fields the desktop acts on.
#[derive(Debug, Clone, PartialEq)]
pub struct NewProjectPrefs {
    pub location: PathBuf,
    pub open_in: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

pub fn new_project(prefs: &Value) -> NewProjectPrefs {
    let np = &prefs["newProject"];
    let raw_location = np["location"]
        .as_str()
        .unwrap_or(default_project_location());
    let migrated_location = migrate_legacy_location(raw_location, is_windows(), &home_dir());
    NewProjectPrefs {
        location: expand_tilde(migrated_location.as_deref().unwrap_or(raw_location)),
        open_in: np["openIn"].as_str().unwrap_or("media").to_string(),
        width: np["width"].as_u64().unwrap_or(1920) as u32,
        height: np["height"].as_u64().unwrap_or(1080) as u32,
        fps: np["fps"].as_u64().unwrap_or(24) as u32,
    }
}

pub fn theme(prefs: &Value) -> &str {
    prefs["theme"].as_str().unwrap_or("system")
}

/// The `density` preference (`"default"` | `"compact"`), normalized on read.
/// The report window carries it in its URL like the settings iframe does.
pub fn density(prefs: &Value) -> &str {
    prefs["density"].as_str().unwrap_or("default")
}

pub fn reopen_last(prefs: &Value) -> bool {
    prefs["onLaunch"].as_str() == Some("last")
}

/// The raw `language` preference (`"system"` or a locale code): Studio and
/// the home page resolve `"system"` themselves. Normalized on read, so this
/// is always a supported value.
pub fn language(prefs: &Value) -> &str {
    prefs["language"].as_str().unwrap_or("system")
}

/// `updates.autoCheck`: check for a new version once after launch.
pub fn auto_check_updates(prefs: &Value) -> bool {
    prefs["updates"]["autoCheck"].as_bool().unwrap_or(true)
}

/// `telemetry.enabled`: send anonymous usage statistics (`telemetry.rs`).
pub fn telemetry_enabled(prefs: &Value) -> bool {
    prefs["telemetry"]["enabled"].as_bool().unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("openvids-prefs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("preferences.json")
    }

    #[test]
    fn a_missing_file_reads_as_the_defaults() {
        let path = tmp("missing");
        assert_eq!(load(&path), defaults_for(is_windows()));
    }

    #[test]
    fn invalid_known_values_fall_back_and_unknown_keys_survive() {
        let path = tmp("invalid");
        std::fs::write(
            &path,
            br#"{"theme":"neon","language":"klingon","onLaunch":"last","density":"huge","updates":{"autoCheck":"sometimes","channel":"beta"},"future":{"x":1},"newProject":{"fps":23,"width":0,"height":1920,"openIn":"story","extra":true}}"#,
        )
        .unwrap();
        let prefs = load(&path);
        assert_eq!(prefs["theme"], "system");
        assert_eq!(prefs["language"], "system");
        assert_eq!(language(&prefs), "system");
        assert_eq!(prefs["onLaunch"], "last");
        assert_eq!(prefs["density"], "default");
        assert_eq!(prefs["updates"]["autoCheck"], true);
        assert_eq!(prefs["updates"]["channel"], "beta");
        assert_eq!(prefs["future"]["x"], 1);
        assert_eq!(prefs["newProject"]["fps"], 24);
        assert_eq!(prefs["newProject"]["width"], 1920);
        assert_eq!(prefs["newProject"]["height"], 1920);
        assert_eq!(prefs["newProject"]["openIn"], "story");
        assert_eq!(prefs["newProject"]["extra"], true);
        assert_eq!(prefs["newProject"]["location"], default_project_location());
    }

    #[test]
    fn platform_defaults_and_legacy_location_migration_are_explicit() {
        assert_eq!(default_project_location_for(true), "~/Documents/OpenVids");
        assert_eq!(
            defaults_for(true)["newProject"]["location"],
            "~/Documents/OpenVids"
        );
        assert_eq!(default_project_location_for(false), "~/Movies/OpenVids");
        assert_eq!(
            defaults_for(false)["newProject"]["location"],
            "~/Movies/OpenVids"
        );

        let home = Path::new(r"C:\Users\Alice");
        for legacy in [
            "~/Movies/OpenVids",
            r"~\Movies\OpenVids",
            r"c:\users\alice\movies\openvids",
            "C:/Users/Alice/Movies/OpenVids",
        ] {
            assert_eq!(
                migrate_legacy_location(legacy, true, home).as_deref(),
                Some("~/Documents/OpenVids")
            );
            assert_eq!(migrate_legacy_location(legacy, false, home), None);
        }
        assert_eq!(migrate_legacy_location(r"D:\Work", true, home), None);
        assert_eq!(
            migrate_legacy_location("~/Videos/OpenVids", true, home),
            None
        );
        let path = tmp("legacy-migration");
        std::fs::write(&path, br#"{"newProject":{"location":"~/Movies/OpenVids"}}"#).unwrap();
        let migrated = load_for(&path, true, home);
        assert_eq!(migrated["newProject"]["location"], "~/Documents/OpenVids");
        let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["newProject"]["location"], "~/Documents/OpenVids");

        std::fs::write(&path, br#"{"newProject":{"location":"D:\\Work"}}"#).unwrap();
        assert_eq!(
            load_for(&path, true, home)["newProject"]["location"],
            r"D:\Work"
        );
        std::fs::write(&path, br#"{"newProject":{"location":"~/Movies/OpenVids"}}"#).unwrap();
        assert_eq!(
            load_for(&path, false, home)["newProject"]["location"],
            "~/Movies/OpenVids"
        );
    }

    #[test]
    fn update_deep_merges_and_keeps_keys_written_by_the_other_side() {
        let path = tmp("merge");
        std::fs::write(
            &path,
            br#"{"studioOnly":{"panel":"left"},"newProject":{"fps":30,"location":"/x"}}"#,
        )
        .unwrap();
        let next = update(&path, &json!({"theme":"light","newProject":{"fps":60}})).unwrap();
        assert_eq!(next["theme"], "light");
        assert_eq!(next["newProject"]["fps"], 60);
        assert_eq!(next["newProject"]["location"], "/x");
        assert_eq!(next["studioOnly"]["panel"], "left");
        // Persisted, and the write left no temp file behind.
        assert_eq!(load(&path), next);
        let leftovers = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn density_and_the_update_choice_are_stored_and_merged() {
        let path = tmp("density");
        std::fs::write(&path, br#"{"updates":{"channel":"beta"}}"#).unwrap();
        let next = update(
            &path,
            &json!({"density":"compact","updates":{"autoCheck":false}}),
        )
        .unwrap();
        assert_eq!(next["density"], "compact");
        assert_eq!(next["updates"]["autoCheck"], false);
        assert_eq!(next["updates"]["channel"], "beta");
        assert_eq!(load(&path), next);
        // An invalid density never lands: it reads back as the default.
        let next = update(&path, &json!({"density":"huge"})).unwrap();
        assert_eq!(next["density"], "default");
        assert_eq!(next["updates"]["autoCheck"], false);
    }

    #[test]
    fn the_statistics_choice_defaults_on_merges_and_falls_back() {
        let path = tmp("telemetry");
        assert_eq!(load(&path)["telemetry"], json!({"enabled": true}));
        assert!(telemetry_enabled(&load(&path)));
        // Unknown keys inside the group survive a merge that turns it off.
        std::fs::write(
            &path,
            br#"{"telemetry":{"note":"x"},"updates":{"autoCheck":false}}"#,
        )
        .unwrap();
        let next = update(&path, &json!({"telemetry":{"enabled":false}})).unwrap();
        assert_eq!(next["telemetry"], json!({"enabled": false, "note": "x"}));
        assert!(!telemetry_enabled(&next));
        assert_eq!(next["updates"]["autoCheck"], false);
        assert_eq!(load(&path), next);
        // A patch that does not name it leaves it alone.
        let next = update(&path, &json!({"theme":"dark"})).unwrap();
        assert_eq!(next["telemetry"]["enabled"], false);
        // Invalid values read as on, the default.
        for bad in [
            r#"{"enabled":"no"}"#,
            r#"{"enabled":0}"#,
            r#"{"enabled":null}"#,
            "false",
            r#""off""#,
        ] {
            std::fs::write(&path, format!(r#"{{"telemetry":{bad}}}"#)).unwrap();
            assert_eq!(load(&path)["telemetry"]["enabled"], true, "{bad}");
        }
    }

    #[test]
    fn language_defaults_to_system_and_round_trips_listed_codes() {
        let path = tmp("language");
        assert_eq!(load(&path)["language"], "system");
        assert_eq!(language(&load(&path)), "system");
        // Unknown keys survive alongside a language change.
        std::fs::write(&path, br#"{"future":{"x":1}}"#).unwrap();
        let next = update(&path, &json!({"language":"en"})).unwrap();
        assert_eq!(next["language"], "en");
        assert_eq!(language(&next), "en");
        assert_eq!(next["future"]["x"], 1);
        assert_eq!(load(&path), next);
        let next = update(&path, &json!({"language":"system"})).unwrap();
        assert_eq!(next["language"], "system");
        assert_eq!(language(&next), "system");
        // A non-string or an unlisted code never lands: it reads as `system`.
        for bad in [r#""klingon""#, "7", "null", "true"] {
            std::fs::write(&path, format!(r#"{{"language":{bad}}}"#)).unwrap();
            assert_eq!(load(&path)["language"], "system", "{bad}");
        }
        std::fs::write(&path, br#"{"language":"en"}"#).unwrap();
        let next = update(&path, &json!({"language":"klingon"})).unwrap();
        assert_eq!(next["language"], "system");
    }

    #[test]
    fn onboarding_defaults_to_not_completed_and_keeps_unknown_keys() {
        let path = tmp("onboarding");
        assert_eq!(load(&path)["onboarding"], json!({"completedAt": null}));
        let done = update(
            &path,
            &json!({"onboarding": {"completedAt": 1790000000000u64}}),
        )
        .unwrap();
        assert_eq!(done["onboarding"]["completedAt"], 1790000000000u64);
        // Unknown keys inside the group survive; a later patch that leaves
        // completedAt out keeps it.
        std::fs::write(
            &path,
            br#"{"onboarding":{"completedAt":1790000000000,"step":"models"}}"#,
        )
        .unwrap();
        let next = update(&path, &json!({"theme": "dark"})).unwrap();
        assert_eq!(next["onboarding"]["completedAt"], 1790000000000u64);
        assert_eq!(next["onboarding"]["step"], "models");
        // Invalid values read as not completed.
        for bad in [r#""yes""#, "true", "0", "-5", "1.5", "[]"] {
            std::fs::write(
                &path,
                format!(r#"{{"onboarding":{{"completedAt":{bad}}}}}"#),
            )
            .unwrap();
            assert_eq!(
                load(&path)["onboarding"]["completedAt"],
                Value::Null,
                "{bad}"
            );
        }
        std::fs::write(&path, br#"{"onboarding":"done"}"#).unwrap();
        assert_eq!(load(&path)["onboarding"], json!({"completedAt": null}));
        // It can be reset (to show the onboarding again) with an explicit null.
        let reset = update(&path, &json!({"onboarding": {"completedAt": 5}})).unwrap();
        assert_eq!(reset["onboarding"]["completedAt"], 5);
        let reset = update(&path, &json!({"onboarding": {"completedAt": null}})).unwrap();
        assert_eq!(reset["onboarding"]["completedAt"], Value::Null);
    }

    #[test]
    fn update_refuses_a_non_object_patch() {
        let path = tmp("non-object");
        assert!(update(&path, &json!([1, 2])).is_err());
        assert!(!path.exists());
    }

    #[test]
    #[cfg(not(windows))]
    fn tilde_round_trips() {
        let home = home_dir();
        assert_eq!(
            expand_tilde("~/Movies/OpenVids"),
            home.join("Movies/OpenVids")
        );
        assert_eq!(expand_tilde("/abs"), PathBuf::from("/abs"));
        assert_eq!(abbreviate_home(&home.join("Movies/X")), "~/Movies/X");
        assert_eq!(
            abbreviate_home(Path::new("/Volumes/SSD/X")),
            "/Volumes/SSD/X"
        );
    }

    #[test]
    #[cfg(windows)]
    fn tilde_round_trips() {
        let home = home_dir();
        assert_eq!(
            expand_tilde("~/Movies/OpenVids"),
            home.join("Movies/OpenVids")
        );
        assert_eq!(expand_tilde("~"), home);
        assert_eq!(expand_tilde(r"C:\abs"), PathBuf::from(r"C:\abs"));
        // A Unix-style absolute path is not absolute on Windows: it stays untouched.
        assert_eq!(expand_tilde("/abs"), PathBuf::from("/abs"));
        assert_eq!(abbreviate_home(&home.join("Movies/X")), "~/Movies/X");
        assert_eq!(abbreviate_home(&home), "~");
        assert_eq!(abbreviate_home(Path::new(r"C:\Windows")), r"C:\Windows");
    }
}
