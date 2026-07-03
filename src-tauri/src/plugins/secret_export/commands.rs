//! `secret-export` command core.
//!
//! The narrow-seam replacement for the removed WebView `fs:allow-write-text-file`
//! `$HOME/**` scope (TB6): the WebView picks the destination via the dialog
//! plugin, this command does the ONLY IO, and no broad fs scope is granted — the
//! backup / importer / export precedent. The destination is re-validated as
//! UNTRUSTED (a compromised WebView could call this directly, bypassing the
//! dialog), rejecting any path that resolves inside the app-data / vault tree.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline" — `contents` is a
//! secret (recovery phrase / account number); it is Zeroizing-wrapped on the
//! first non-doc statement and never logged.

use super::error::SecretExportError;
use std::path::Path;
use tauri::{AppHandle, Runtime};
use zeroize::Zeroizing;

/// Reject a destination that is unusable OR resolves inside `app_data` (which
/// contains `vaults/`). The load-bearing guard: `dest` is WebView-supplied
/// (TB6), so without the containment check a compromised WebView could bypass
/// the save dialog and overwrite `vault.meta` / `.myn` blobs — the exact
/// arbitrary-write the removed fs scope allowed. Mirrors
/// `export::validate_destination`; pure + testable with a temp `app_data`.
fn validate_secret_destination(dest: &Path, app_data: &Path) -> Result<(), SecretExportError> {
    // Parent must exist + be a directory (also excludes an empty/filename-less path).
    if !crate::paths::parent_dir_ok(dest) {
        return Err(SecretExportError::InvalidDestination);
    }
    // Canonicalize the parent (resolve symlinks + `..`) before the containment test.
    let canon_parent = dest
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .ok_or(SecretExportError::InvalidDestination)?;
    if let Ok(canon_app_data) = app_data.canonicalize() {
        if canon_parent.starts_with(&canon_app_data) {
            return Err(SecretExportError::InvalidDestination);
        }
    }
    Ok(())
}

/// Write the secret `contents` to the user-chosen `path` returned by the save
/// dialog. Rejects any destination inside the app-data / vault tree.
#[tauri::command]
pub async fn save_secret_text<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    contents: String,
) -> Result<(), SecretExportError> {
    // First non-doc statement: bound the secret's lifetime to a Zeroizing wrapper.
    let contents = Zeroizing::new(contents);
    let dest = std::path::PathBuf::from(&path);

    let app_data = crate::paths::app_data_dir(&app).map_err(|_| SecretExportError::Io {
        io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
    })?;
    validate_secret_destination(&dest, &app_data)?;

    // User destination → `atomic_write_unclobbered` (randomized temp name; never
    // truncates a pre-existing `<target>.tmp`). `replace = true`: the OS save
    // dialog already confirmed any overwrite of the chosen file.
    tokio::task::spawn_blocking(move || {
        crate::atomic_write::atomic_write_unclobbered(&dest, contents.as_bytes(), true)
    })
    .await
    .map_err(|_| SecretExportError::Io {
        io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
    })?
    .map_err(|e| SecretExportError::Io {
        io_error_kind: crate::io_failure_kind::from_io_error_kind(e.kind()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    #[test]
    fn accepts_and_writes_a_destination_outside_app_data() {
        let app_data = ScopedTempDir::new("secret-export-appdata").expect("tempdir");
        let out = ScopedTempDir::new("secret-export-out").expect("tempdir");
        let dest = out.path().join("myne-recovery-phrase.txt");

        validate_secret_destination(&dest, app_data.path()).expect("outside app-data → ok");
        // The command's post-validation write path.
        crate::atomic_write::atomic_write_unclobbered(&dest, b"correct horse battery staple", true)
            .expect("write");
        assert_eq!(
            std::fs::read_to_string(&dest).expect("read back"),
            "correct horse battery staple"
        );
    }

    #[test]
    fn rejects_a_destination_inside_the_app_data_vault_tree() {
        // Simulate the real layout: a vault dir nested under app_data. A WebView
        // that bypassed the dialog to target vault.meta must be rejected.
        let app_data = ScopedTempDir::new("secret-export-appdata2").expect("tempdir");
        let vault_dir = app_data.path().join("vaults").join("0abc");
        std::fs::create_dir_all(&vault_dir).expect("mkdir vault");
        let dest = vault_dir.join("vault.meta");
        assert_eq!(
            validate_secret_destination(&dest, app_data.path()),
            Err(SecretExportError::InvalidDestination),
            "a destination inside the app-data/vault tree must be rejected"
        );
    }

    #[test]
    fn rejects_a_destination_with_a_missing_parent() {
        let app_data = ScopedTempDir::new("secret-export-appdata3").expect("tempdir");
        let out = ScopedTempDir::new("secret-export-out3").expect("tempdir");
        let dest = out.path().join("no-such-dir").join("kit.txt");
        assert_eq!(
            validate_secret_destination(&dest, app_data.path()),
            Err(SecretExportError::InvalidDestination)
        );
    }

    #[test]
    fn overwrites_an_existing_destination() {
        let app_data = ScopedTempDir::new("secret-export-appdata4").expect("tempdir");
        let out = ScopedTempDir::new("secret-export-out4").expect("tempdir");
        let dest = out.path().join("kit.txt");
        std::fs::write(&dest, "old").expect("seed");
        validate_secret_destination(&dest, app_data.path()).expect("ok");
        crate::atomic_write::atomic_write_unclobbered(&dest, b"new", true).expect("overwrite");
        assert_eq!(std::fs::read_to_string(&dest).expect("read"), "new");
    }
}
