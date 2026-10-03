//! Turning a directory the user picked into something Studio can serve.
//!
//! Studio identifies a project by a single path segment — the name of the
//! directory it lives in — and `isValidProjectId` rejects anything containing
//! a separator, a colon, or a control character. Every id here comes from a
//! real directory name, so the only checks that earn their keep are the ones
//! that stop a non-directory or an unreadable path from reaching the server.

use std::path::{Path, PathBuf};

use serde_json::json;

use super::coded_error::CodedError;

#[derive(Debug)]
pub enum ProjectError {
    NotADirectory(PathBuf),
    NoName(PathBuf),
    UnsafeName(String),
}

impl std::fmt::Display for ProjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotADirectory(path) => write!(f, "{} is not a directory", path.display()),
            Self::NoName(path) => write!(f, "{} has no directory name to use as a project id", path.display()),
            Self::UnsafeName(name) => write!(
                f,
                "{name:?} cannot be used as a project id: it contains a path separator or a reserved character"
            ),
        }
    }
}

impl ProjectError {
    /// The same sentence as `Display`, with the code and params the page translates it by.
    pub fn coded(&self) -> CodedError {
        let message = self.to_string();
        match self {
            Self::NotADirectory(path) => {
                CodedError::new("not_a_directory", message, json!({ "path": path.display().to_string() }))
            }
            Self::NoName(path) => {
                CodedError::new("no_project_name", message, json!({ "path": path.display().to_string() }))
            }
            Self::UnsafeName(name) => CodedError::new("unsafe_project_name", message, json!({ "name": name })),
        }
    }
}

impl std::error::Error for ProjectError {}

/// A validated project directory plus the id Studio will know it by.
#[derive(Debug, Clone)]
pub struct Project {
    pub dir: PathBuf,
    pub id: String,
}

/// Studio's rule, restated so a bad directory name fails here with a clear
/// message instead of a 404 much later. Mirrors
/// `isValidProjectId` in `packages/studio/src/utils/projectRouting.ts`.
pub fn is_valid_project_id(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains(':')
        && !value.contains('/')
        && !value.contains('\\')
        && !value.chars().any(|c| (c as u32) < 32)
}

pub fn validate(dir: &Path) -> Result<Project, ProjectError> {
    // `canonicalize()` returns `\\?\`-prefixed paths on Windows; strip the
    // prefix so stored dirs, recents dedup and Studio project ids stay stable
    // and equal for the same folder.
    let dir = super::platform::canonical_stable(dir);
    if !dir.is_dir() {
        return Err(ProjectError::NotADirectory(dir));
    }
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| ProjectError::NoName(dir.clone()))?;
    if !is_valid_project_id(&name) {
        return Err(ProjectError::UnsafeName(name));
    }
    Ok(Project { dir, id: name })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(windows))]
    fn rejects_paths_that_are_not_directories() {
        let err = validate(Path::new("/definitely/not/here/openvids")).unwrap_err();
        assert!(matches!(err, ProjectError::NotADirectory(_)));
    }

    #[test]
    #[cfg(windows)]
    fn rejects_paths_that_are_not_directories() {
        let err = validate(Path::new(r"C:\definitely\not\here\openvids")).unwrap_err();
        assert!(matches!(err, ProjectError::NotADirectory(_)));
    }

    #[test]
    fn accepts_a_real_directory_and_uses_its_name_as_the_id() {
        let dir = std::env::temp_dir();
        let project = validate(&dir).unwrap();
        assert_eq!(project.id, dir.file_name().unwrap().to_string_lossy());
    }

    #[test]
    fn reserved_ids_are_refused() {
        for name in ["", ".", "..", "a:b", "a/b", "a\\b", "a\u{1}b"] {
            assert!(!is_valid_project_id(name), "{name:?} should be refused");
        }
    }

    #[test]
    fn ordinary_names_are_accepted() {
        for name in ["demo", "My Video", "v1.2_final", "한글"] {
            assert!(is_valid_project_id(name), "{name:?} should be accepted");
        }
    }

    #[test]
    fn validate_never_returns_a_verbatim_prefixed_dir() {
        let base = std::env::temp_dir().join(format!("openvids-validate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let project = validate(&base).unwrap();
        assert!(!project.dir.to_string_lossy().starts_with(r"\\?\"));
        assert_eq!(project.id, base.file_name().unwrap().to_string_lossy());
        let _ = std::fs::remove_dir_all(&base);
    }
}
