//! Real file paths for an OS file drop on the Projects page.
//!
//! The window keeps Tauri's drag-drop handler off (`disable_drag_drop_handler`
//! in lib.rs): with it on, Tauri swallows every OS drop and Studio's HTML5
//! imports (`AssetsTab`, `FileTree`) and in-page drags stop working, and the
//! handler cannot be switched per page. So the webview handles the drop
//! itself, which gives the page `File` objects without paths.
//!
//! The paths are still on the macOS *drag* pasteboard (`NSPasteboardNameDrag`)
//! after the drop: AppKit only replaces it when the next drag starts. The home
//! page posts the dropped file names; this reads the pasteboard's file list
//! and returns the entries whose names match, so a stale pasteboard from an
//! earlier drag can never be mistaken for this drop. Nothing is streamed
//! through JavaScript — the files are copied from these paths on Start.
//!
//! Windows has no equivalent of the drag pasteboard readable from Rust, so
//! `drag_pasteboard_paths()` stays empty there: the first Windows version is
//! file-picker-only. The page already degrades gracefully — a drop with no
//! pasteboard hit resolves zero files, and the composer reports every dropped
//! name via `unresolved`/`skipped` toasts instead of promising a drop-to-add
//! (`home.composer.skipped.*`) — so no JS change is needed.

use std::path::PathBuf;

/// File paths currently on the drag pasteboard. `NSFilenamesPboardType` is
/// deprecated in favour of per-item file URLs, but Finder still writes it and
#[cfg(target_os = "macos")]
#[allow(deprecated)]
pub fn drag_pasteboard_paths() -> Vec<PathBuf> {
    use objc2_app_kit::{NSFilenamesPboardType, NSPasteboard, NSPasteboardNameDrag};
    use objc2_foundation::{NSArray, NSString};

    let mut out = Vec::new();
    // SAFETY: AppKit statics; reading a named pasteboard is thread-safe.
    let pasteboard = unsafe { NSPasteboard::pasteboardWithName(NSPasteboardNameDrag) };
    let wanted = unsafe { NSArray::from_slice(&[NSFilenamesPboardType]) };
    if pasteboard.availableTypeFromArray(&wanted).is_none() {
        return out;
    }
    let Some(list) = (unsafe { pasteboard.propertyListForType(NSFilenamesPboardType) }) else {
        return out;
    };
    let Ok(list) = list.downcast::<NSArray>() else {
        return out;
    };
    for item in list.iter() {
        if let Ok(path) = item.downcast::<NSString>() {
            out.push(PathBuf::from(path.to_string()));
        }
    }
    out
}

/// No drag-pasteboard equivalent outside macOS: Windows is file-picker-only
/// in the first version (see the module docs), Linux keeps the old stub.
#[cfg(not(target_os = "macos"))]
pub fn drag_pasteboard_paths() -> Vec<PathBuf> {
    Vec::new()
}

/// Keep the pasteboard paths whose file names were dropped, in drop order.
/// Duplicate names map to distinct paths, each used once.
pub fn match_dropped(names: &[String], mut candidates: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for name in names {
        if let Some(i) = candidates.iter().position(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy() == name.as_str())
                .unwrap_or(false)
        }) {
            out.push(candidates.remove(i));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(windows))]
    fn only_dropped_names_are_returned_in_drop_order() {
        let candidates = vec![
            PathBuf::from("/a/one.mov"),
            PathBuf::from("/b/two.wav"),
            PathBuf::from("/c/one.mov"),
            PathBuf::from("/d/stale.txt"),
        ];
        let names = vec!["two.wav".to_string(), "one.mov".to_string(), "one.mov".to_string(), "missing.png".to_string()];
        assert_eq!(
            match_dropped(&names, candidates),
            vec![
                PathBuf::from("/b/two.wav"),
                PathBuf::from("/a/one.mov"),
                PathBuf::from("/c/one.mov")
            ]
        );
    }

    #[test]
    #[cfg(windows)]
    fn only_dropped_names_are_returned_in_drop_order() {
        let candidates = vec![
            PathBuf::from(r"C:\a\one.mov"),
            PathBuf::from(r"C:\b\two.wav"),
            PathBuf::from(r"C:\c\one.mov"),
            PathBuf::from(r"C:\d\stale.txt"),
        ];
        let names = vec!["two.wav".to_string(), "one.mov".to_string(), "one.mov".to_string(), "missing.png".to_string()];
        assert_eq!(
            match_dropped(&names, candidates),
            vec![
                PathBuf::from(r"C:\b\two.wav"),
                PathBuf::from(r"C:\a\one.mov"),
                PathBuf::from(r"C:\c\one.mov")
            ]
        );
    }

    #[test]
    #[cfg(windows)]
    fn the_windows_pasteboard_stays_empty() {
        // First Windows version is file-picker-only: drops resolve nothing
        // and the composer reports the names via `unresolved` toasts.
        assert!(drag_pasteboard_paths().is_empty());
    }
}
