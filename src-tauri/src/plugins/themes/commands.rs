//! Tauri command surface for custom themes (custom-themes epic, MYND-297,
//! task 2): `list_custom_themes` / `read_custom_theme` / `delete_custom_theme`
//! over `app_config_dir/themes/`.
//!
//! Theme files are **device-local plaintext app-config** (not vault content, not
//! Slot-gated) — these commands operate on the global themes directory and do
//! not touch vault state. Every name-taking command runs the
//! [`is_valid_theme_name`] path-traversal guard BEFORE any path join (TB6).
//! Validation reuses the pure `themes` validator ([`validate_theme`]).
//!
//! The `_in(dir, …)` cores take an explicit directory so they are unit-testable
//! without a Tauri `AppHandle` (the prefs-plugin `_with_dir` precedent).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use super::error::ThemeCommandError;
use super::info::ThemeInfo;
use super::name::is_valid_theme_name;
use super::value::validate_theme;

/// Resolve `<app_config_dir>/themes/` for the running app.
fn themes_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, ThemeCommandError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|_| ThemeCommandError::Io {
            io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
        })?;
    Ok(config_dir.join("themes"))
}

/// List every well-named `*.json` theme file in `dir`, validated. An absent or
/// unreadable directory yields an empty list (the no-themes default). Files
/// whose stem is not a valid theme name, or that aren't `*.json`, are skipped.
/// Invalid files still appear (`valid: false` + error) so the picker can grey
/// them rather than dropping them silently. Sorted by name for determinism.
pub fn list_custom_themes_in(dir: &Path) -> Vec<ThemeInfo> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_valid_theme_name(stem) {
            continue;
        }
        let name = stem.to_string();
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue; // unreadable file: skip (not a user-actionable list row)
        };
        out.push(ThemeInfo::from_validation(name, validate_theme(&content)));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Read + validate one theme by name, returning its CSS-variable palette map.
/// Rejects an unsafe name before any path join.
pub fn read_custom_theme_in(
    dir: &Path,
    name: &str,
) -> Result<BTreeMap<String, String>, ThemeCommandError> {
    if !is_valid_theme_name(name) {
        return Err(ThemeCommandError::InvalidName);
    }
    let path = dir.join(format!("{name}.json"));
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ThemeCommandError::NotFound)
        }
        Err(e) => return Err(e.into()),
    };
    validate_theme(&content)
        .map(|theme| theme.vars)
        .map_err(|error| ThemeCommandError::Invalid { error })
}

/// Delete one theme file by name. Idempotent: deleting an absent theme is a
/// no-op success (no `*ArtifactsPresent` canary — a theme file is recreatable
/// plaintext config, closer to `note_delete` than a vault artifact). Rejects an
/// unsafe name before any path join.
pub fn delete_custom_theme_in(dir: &Path, name: &str) -> Result<(), ThemeCommandError> {
    if !is_valid_theme_name(name) {
        return Err(ThemeCommandError::InvalidName);
    }
    let path = dir.join(format!("{name}.json"));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Import a user-picked theme file into `dir`: read the source, validate it,
/// derive a safe name from the source's file-stem, and place it as
/// `<name>.json`. Rejects an unsafe source name (`InvalidName`) or invalid
/// content (`Invalid`) before writing. Creates `dir` if missing. Overwrites an
/// existing theme of the same name (re-import updates).
pub fn import_custom_theme_into(dir: &Path, source: &Path) -> Result<ThemeInfo, ThemeCommandError> {
    let content = match std::fs::read_to_string(source) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ThemeCommandError::NotFound)
        }
        Err(e) => return Err(e.into()),
    };
    let name = source
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| is_valid_theme_name(s))
        .ok_or(ThemeCommandError::InvalidName)?
        .to_string();
    let theme = validate_theme(&content).map_err(|error| ThemeCommandError::Invalid { error })?;
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(format!("{name}.json")), &content)?;
    Ok(ThemeInfo::from_validation(name, Ok(theme)))
}

/// IPC: list all custom themes (validated) for the picker UI.
#[tauri::command]
pub async fn list_custom_themes<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<ThemeInfo>, ThemeCommandError> {
    let dir = themes_dir(&app)?;
    Ok(list_custom_themes_in(&dir))
}

/// IPC: read + validate one theme's palette (consumed by the apply layer).
#[tauri::command]
pub async fn read_custom_theme<R: Runtime>(
    app: AppHandle<R>,
    name: String,
) -> Result<BTreeMap<String, String>, ThemeCommandError> {
    let dir = themes_dir(&app)?;
    read_custom_theme_in(&dir, &name)
}

/// IPC: delete one theme file (idempotent).
#[tauri::command]
pub async fn delete_custom_theme<R: Runtime>(
    app: AppHandle<R>,
    name: String,
) -> Result<(), ThemeCommandError> {
    let dir = themes_dir(&app)?;
    delete_custom_theme_in(&dir, &name)
}

/// IPC: import a user-picked `.json` theme file into the themes directory.
#[tauri::command]
pub async fn import_custom_theme<R: Runtime>(
    app: AppHandle<R>,
    source_path: String,
) -> Result<ThemeInfo, ThemeCommandError> {
    let dir = themes_dir(&app)?;
    import_custom_theme_into(&dir, std::path::Path::new(&source_path))
}

/// IPC: ensure the themes directory exists and return its path (for the picker's
/// "Open themes folder" reveal). Returns the user's own config-dir path — used
/// for `revealItemInDir`, not secret material.
#[tauri::command]
pub async fn ensure_themes_dir<R: Runtime>(app: AppHandle<R>) -> Result<String, ThemeCommandError> {
    let dir = themes_dir(&app)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::themes::error::ThemeErrorKind;
    use crate::plugins::themes::schema::REQUIRED_KEYS;
    use crate::test_support::ScopedTempDir;

    fn valid_theme_json() -> String {
        let mut s = String::from("{\n");
        for (i, key) in REQUIRED_KEYS.iter().enumerate() {
            let comma = if i + 1 < REQUIRED_KEYS.len() { "," } else { "" };
            s.push_str(&format!("  \"{key}\": \"#123456\"{comma}\n"));
        }
        s.push('}');
        s
    }

    fn write_theme(dir: &Path, name: &str, content: &str) {
        std::fs::write(dir.join(format!("{name}.json")), content).expect("write theme file");
    }

    #[test]
    fn list_is_empty_when_dir_absent() {
        let tmp = ScopedTempDir::new("themes-absent").expect("tempdir");
        let missing = tmp.path().join("does-not-exist");
        assert!(list_custom_themes_in(&missing).is_empty());
    }

    #[test]
    fn list_returns_valid_info_with_preview() {
        let tmp = ScopedTempDir::new("themes-valid").expect("tempdir");
        write_theme(tmp.path(), "solar", &valid_theme_json());
        let list = list_custom_themes_in(tmp.path());
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "solar");
        assert!(list[0].valid);
        let preview = list[0].preview.as_ref().expect("valid theme has a preview");
        assert_eq!(preview.background, "#123456"); // --paper
        assert_eq!(preview.accent, "#123456"); // --accent
        assert!(list[0].error.is_none());
    }

    #[test]
    fn list_includes_invalid_file_greyed_with_error() {
        let tmp = ScopedTempDir::new("themes-invalid").expect("tempdir");
        write_theme(tmp.path(), "broken", "{ \"--paper\": \"url(evil)\" }");
        let list = list_custom_themes_in(tmp.path());
        assert_eq!(list.len(), 1);
        assert!(!list[0].valid);
        assert!(list[0].preview.is_none());
        assert!(list[0].error.is_some());
    }

    #[test]
    fn list_skips_non_json_and_unsafe_named_files() {
        let tmp = ScopedTempDir::new("themes-skip").expect("tempdir");
        std::fs::write(tmp.path().join("notes.txt"), "x").unwrap();
        std::fs::write(tmp.path().join("..secret.json"), "{}").unwrap(); // unsafe stem '..secret'
        write_theme(tmp.path(), "ok", &valid_theme_json());
        let list = list_custom_themes_in(tmp.path());
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "ok");
    }

    #[test]
    fn read_returns_palette_for_valid_theme() {
        let tmp = ScopedTempDir::new("themes-read").expect("tempdir");
        write_theme(tmp.path(), "solar", &valid_theme_json());
        let vars = read_custom_theme_in(tmp.path(), "solar").expect("valid theme reads");
        assert_eq!(vars.get("--accent").map(String::as_str), Some("#123456"));
        assert_eq!(vars.len(), REQUIRED_KEYS.len());
    }

    #[test]
    fn read_rejects_traversal_name_before_touching_disk() {
        let tmp = ScopedTempDir::new("themes-read-bad").expect("tempdir");
        let err = read_custom_theme_in(tmp.path(), "../etc/passwd").expect_err("traversal rejects");
        assert_eq!(err, ThemeCommandError::InvalidName);
    }

    #[test]
    fn read_missing_theme_is_not_found() {
        let tmp = ScopedTempDir::new("themes-read-missing").expect("tempdir");
        let err = read_custom_theme_in(tmp.path(), "ghost").expect_err("absent theme");
        assert_eq!(err, ThemeCommandError::NotFound);
    }

    #[test]
    fn read_invalid_theme_surfaces_validation_error() {
        let tmp = ScopedTempDir::new("themes-read-invalid").expect("tempdir");
        write_theme(tmp.path(), "broken", "{ \"--paper\": \"#fff\" }"); // missing required keys
        let err = read_custom_theme_in(tmp.path(), "broken").expect_err("invalid theme");
        match err {
            ThemeCommandError::Invalid { error } => {
                assert_eq!(error.kind, ThemeErrorKind::MissingKey)
            }
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn delete_removes_then_is_idempotent() {
        let tmp = ScopedTempDir::new("themes-delete").expect("tempdir");
        write_theme(tmp.path(), "solar", &valid_theme_json());
        assert!(tmp.path().join("solar.json").exists());
        delete_custom_theme_in(tmp.path(), "solar").expect("delete");
        assert!(!tmp.path().join("solar.json").exists());
        // Deleting again is a no-op success.
        delete_custom_theme_in(tmp.path(), "solar").expect("idempotent delete");
    }

    #[test]
    fn delete_rejects_traversal_name() {
        let tmp = ScopedTempDir::new("themes-delete-bad").expect("tempdir");
        let err = delete_custom_theme_in(tmp.path(), "../x").expect_err("traversal rejects");
        assert_eq!(err, ThemeCommandError::InvalidName);
    }

    #[test]
    fn import_places_valid_theme_and_returns_info() {
        let src = ScopedTempDir::new("themes-import-src").expect("tempdir");
        let dst = ScopedTempDir::new("themes-import-dst").expect("tempdir");
        let source = src.path().join("solar.json");
        std::fs::write(&source, valid_theme_json()).unwrap();
        let info = import_custom_theme_into(dst.path(), &source).expect("import valid theme");
        assert_eq!(info.name, "solar");
        assert!(info.valid);
        assert!(dst.path().join("solar.json").exists());
    }

    #[test]
    fn import_rejects_unsafe_source_name() {
        let src = ScopedTempDir::new("themes-import-badname-src").expect("tempdir");
        let dst = ScopedTempDir::new("themes-import-badname-dst").expect("tempdir");
        // A source file whose stem contains a dot is not a valid theme name.
        let source = src.path().join("my.theme.json");
        std::fs::write(&source, valid_theme_json()).unwrap();
        let err = import_custom_theme_into(dst.path(), &source).expect_err("unsafe name rejects");
        assert_eq!(err, ThemeCommandError::InvalidName);
    }

    #[test]
    fn import_rejects_invalid_content_without_placing() {
        let src = ScopedTempDir::new("themes-import-bad-src").expect("tempdir");
        let dst = ScopedTempDir::new("themes-import-bad-dst").expect("tempdir");
        let source = src.path().join("broken.json");
        std::fs::write(&source, "{ \"--paper\": \"url(evil)\" }").unwrap();
        let err =
            import_custom_theme_into(dst.path(), &source).expect_err("invalid content rejects");
        assert!(matches!(err, ThemeCommandError::Invalid { .. }));
        assert!(
            !dst.path().join("broken.json").exists(),
            "rejected import must not be placed"
        );
    }

    #[test]
    fn import_missing_source_is_not_found() {
        let dst = ScopedTempDir::new("themes-import-missing").expect("tempdir");
        let err = import_custom_theme_into(dst.path(), Path::new("/no/such/theme.json"))
            .expect_err("missing source");
        assert_eq!(err, ThemeCommandError::NotFound);
    }
}
