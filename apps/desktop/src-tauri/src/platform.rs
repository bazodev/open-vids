//! Names that differ between the platforms OpenVids ships on.
//!
//! `home_dir()` resolves EXACTLY like Node's `os.homedir()`: `USERPROFILE` on
//! Windows (falling back to the OS profile directory), `$HOME` on Unix. Both
//! sides put `~/.openvids` (preferences, the Asset Search policy,
//! `OPENVIDS_RESEARCH_DIR`'s default) under this directory, so Rust and the
//! JS sidecar (`preferences.ts`, `policyStore.ts`, `settings.ts`) must agree.

use std::path::{Path, PathBuf};

/// File name of the bundled JS runtime: `bun.exe` on Windows, `bun` elsewhere.
/// `apps/desktop/scripts/stage-runtime.mjs` stages it under this name and
/// `tauri.prod*.conf.json` bundles it, so the three must agree.
pub const BUN_BIN: &str = if cfg!(windows) { "bun.exe" } else { "bun" };

/// `ffmpeg` / `ffprobe` with the platform's executable suffix.
pub fn exe_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// Widest start window: 3:2 (width : height).
const START_MAX_ASPECT: f64 = 1.5;
/// Gap kept on every side of the start window on a landscape screen (logical px).
const START_GAP: f64 = 48.0;
/// Gap kept left and right of the start window on a square or portrait screen
/// (logical px): smaller than [`START_GAP`], so the window uses the width.
const START_GAP_SIDE_PORTRAIT: f64 = 24.0;

/// The start size (logical px) of the main window for a screen work area of
/// `area_w` x `area_h` logical px, so the first window looks the same on every
/// display:
///
/// - a landscape area (wider than tall) grows with a fixed `START_GAP` on every
///   side: the height fills the area, and the width follows at 3:2 until the
///   area is too narrow for that, then the width takes what is left
///   (a ratio between 3:2 and 1:1);
/// - a square or portrait area is a 1:1 window with the smaller
///   `START_GAP_SIDE_PORTRAIT` gap at the sides.
///
/// The ratio never leaves 1:1 ..= 3:2. Pure, so the geometry is tested on every
/// platform; only the Windows window builder calls it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn start_window_size(area_w: f64, area_h: f64) -> (f64, f64) {
    let gap = if area_w > area_h {
        START_GAP
    } else {
        START_GAP_SIDE_PORTRAIT
    };
    let free_w = (area_w - 2.0 * gap).max(1.0);
    let free_h = (area_h - 2.0 * gap).max(1.0);
    // Never taller than wide (1:1 floor), never wider than 3:2.
    let height = free_h.min(free_w);
    let width = free_w.min(START_MAX_ASPECT * height);
    (width.round(), height.round())
}

#[cfg(test)]
mod start_size_tests {
    use super::start_window_size;

    #[test]
    fn a_wide_screen_stops_at_3_2_with_the_fixed_gap_above_and_below() {
        // 1920x1080 work area at 100%: height = 1080 - 2*48, width = 1.5 * height.
        assert_eq!(start_window_size(1920.0, 1080.0), (1476.0, 984.0));
        // An ultra-wide screen gives the same 3:2 window, it never gets wider.
        assert_eq!(start_window_size(3440.0, 1040.0), (1416.0, 944.0));
    }

    #[test]
    fn a_narrower_landscape_screen_keeps_the_height_and_takes_the_remaining_width() {
        // 4:3 area: 1.5 * 984 would not fit, the width is what is left (ratio 1.25).
        let (w, h) = start_window_size(1280.0, 1024.0);
        assert_eq!((w, h), (1184.0, 928.0));
        assert!(w / h > 1.0 && w / h < 1.5);
    }

    #[test]
    fn a_square_or_portrait_screen_is_1_to_1_with_the_small_side_gap() {
        assert_eq!(start_window_size(1000.0, 1000.0), (952.0, 952.0));
        // Portrait monitor: 24 px at each side, a square window, centred vertically by the caller.
        assert_eq!(start_window_size(1080.0, 1920.0), (1032.0, 1032.0));
    }

    #[test]
    fn the_ratio_stays_between_1_to_1_and_3_to_2_on_any_area() {
        for (w, h) in [
            (800.0, 450.0),
            (1366.0, 728.0),
            (1536.0, 816.0),
            (2560.0, 1400.0),
            (5120.0, 1400.0),
            (700.0, 1200.0),
            (500.0, 500.0),
        ] {
            let (width, height) = start_window_size(w, h);
            let ratio = width / height;
            assert!(
                (1.0..=1.5 + 0.01).contains(&ratio),
                "{w}x{h} gave {width}x{height} (ratio {ratio})"
            );
            assert!(width <= w && height <= h);
        }
    }
}

/// The user's home directory, resolved exactly like Node's `os.homedir()`:
/// on Windows `USERPROFILE` first (Node ignores `HOME` there — verified:
/// `HOME=C:\definitely-not-home node -e "os.homedir()"` still prints the
/// profile dir), else the OS profile directory; on Unix `$HOME`, else the
/// temp dir as a last resort. An empty `USERPROFILE` makes Node's `homedir()`
/// throw, so fall through instead of returning an empty path.
pub fn home_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(dir) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
            return PathBuf::from(dir);
        }
        profile_dir_from_api().unwrap_or_else(std::env::temp_dir)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
    }
}

/// The OS profile directory on Windows (`SHGetKnownFolderPath(FOLDERID_Profile)`),
/// the fallback when `USERPROFILE` is unset. `None` when the API fails.
#[cfg(windows)]
fn profile_dir_from_api() -> Option<PathBuf> {
    #[repr(C)]
    struct Guid {
        a: u32,
        b: u16,
        c: u16,
        d: [u8; 8],
    }
    // FOLDERID_Profile = {5E6C858F-0E22-4760-9AFE-EA3317B67173}.
    const FOLDERID_PROFILE: Guid = Guid {
        a: 0x5E6C_858F,
        b: 0x0E22,
        c: 0x4760,
        d: [0x9A, 0xFE, 0xEA, 0x33, 0x17, 0xB6, 0x71, 0x73],
    };
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHGetKnownFolderPath(
            rfid: *const Guid,
            dwflags: u32,
            htoken: *mut std::ffi::c_void,
            ppszpath: *mut *mut u16,
        ) -> i32;
        fn CoTaskMemFree(pv: *mut std::ffi::c_void);
    }
    let mut raw: *mut u16 = std::ptr::null_mut();
    // SAFETY: SHGetKnownFolderPath writes a null-terminated UTF-16 path (or
    // leaves the pointer null on failure); CoTaskMemFree releases it.
    let code = unsafe { SHGetKnownFolderPath(&FOLDERID_PROFILE, 0, std::ptr::null_mut(), &mut raw) };
    if code != 0 || raw.is_null() {
        return None;
    }
    let len = unsafe {
        let mut n = 0;
        while *raw.add(n) != 0 {
            n += 1;
        }
        n
    };
    let path = PathBuf::from(unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(raw, len)) });
    unsafe { CoTaskMemFree(raw.cast()) };
    (!path.as_os_str().is_empty()).then_some(path)
}

/// Strip the `\\?\` verbatim prefix `canonicalize()` produces on Windows, so
/// stored project paths, recents dedup keys and Studio project ids stay
/// stable and equal for the same folder regardless of how it was resolved.
pub fn from_verbatim(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        const VERBATIM: &str = r"\\?\";
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(VERBATIM) {
            // `\\?\UNC\host\share\…` is the verbatim form of `\\host\share\…`.
            if let Some(unc) = rest.strip_prefix(r"UNC\") {
                return PathBuf::from(format!(r"\\{unc}"));
            }
            return PathBuf::from(rest);
        }
        path.to_path_buf()
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

/// `canonicalize()` with the Windows verbatim prefix stripped. Falls back to
/// the input on error, like every existing call site already does.
pub fn canonical_stable(dir: &Path) -> PathBuf {
    match dir.canonicalize() {
        Ok(resolved) => from_verbatim(&resolved),
        Err(_) => from_verbatim(dir),
    }
}

/// Case-insensitive path equality on Windows (the filesystem is
/// case-insensitive but case-preserving); exact equality elsewhere.
pub fn same_path(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        a.as_os_str().to_string_lossy().to_lowercase() == b.as_os_str().to_string_lossy().to_lowercase()
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_name_follows_the_platform() {
        if cfg!(windows) {
            assert_eq!(exe_name("ffmpeg"), "ffmpeg.exe");
            assert_eq!(BUN_BIN, "bun.exe");
        } else {
            assert_eq!(exe_name("ffmpeg"), "ffmpeg");
            assert_eq!(BUN_BIN, "bun");
        }
    }

    #[test]
    fn home_dir_matches_the_platform_convention() {
        let home = home_dir();
        assert!(!home.as_os_str().is_empty());
        assert!(home.is_absolute(), "home {home:?} should be absolute");
        #[cfg(windows)]
        {
            // USERPROFILE set (the normal case) wins over HOME: Node ignores
            // HOME on Windows, so must we.
            if let Some(profile) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
                assert_eq!(home, PathBuf::from(profile));
            }
        }
        #[cfg(not(windows))]
        {
            if let Some(expected) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
                assert_eq!(home, PathBuf::from(expected));
            }
        }
    }

    #[test]
    #[cfg(windows)]
    fn home_dir_ignores_home_and_prefers_userprofile() {
        let profile = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty());
        if profile.is_none() {
            return;
        }
        // Poisoning HOME must not move `~`: matches `os.homedir()`.
        std::env::set_var("HOME", r"C:\definitely-not-home");
        assert_eq!(home_dir(), PathBuf::from(profile.expect("checked above")));
    }

    #[test]
    fn verbatim_prefixes_are_stripped() {
        #[cfg(windows)]
        {
            assert_eq!(
                from_verbatim(Path::new(r"\\?\C:\Users\me\x")),
                PathBuf::from(r"C:\Users\me\x")
            );
            assert_eq!(
                from_verbatim(Path::new(r"\\?\UNC\host\share\x")),
                PathBuf::from(r"\\host\share\x")
            );
            assert_eq!(
                from_verbatim(Path::new(r"C:\plain\x")),
                PathBuf::from(r"C:\plain\x")
            );
        }
        #[cfg(not(windows))]
        {
            let plain = Path::new("/tmp/x");
            assert_eq!(from_verbatim(plain), plain);
        }
    }

    #[test]
    fn same_path_follows_filesystem_case_rules() {
        if cfg!(windows) {
            assert!(same_path(Path::new(r"C:\Users\Me\X"), Path::new(r"c:\users\me\x")));
            assert!(!same_path(Path::new(r"C:\a"), Path::new(r"C:\b")));
        } else {
            assert!(same_path(Path::new("/a"), Path::new("/a")));
            assert!(!same_path(Path::new("/A"), Path::new("/a")));
        }
    }
}
