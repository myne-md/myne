// SPDX-License-Identifier: AGPL-3.0
//! `secret-export` command core.
//!
//! The narrow-seam replacement for the removed WebView `fs:allow-write-text-file`
//! `$HOME/**` scope (TB6): the WebView picks the destination via the dialog
//! plugin, this command does the ONLY IO, and no broad fs scope is granted — the
//! backup / importer / export precedent. The destination is re-validated as
//! UNTRUSTED (a compromised WebView could call this directly, bypassing the
//! dialog), rejecting any path that resolves inside the app-data / vault tree.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline" — `contents` is a
//! secret (recovery phrase / account number); it is Zeroizing-wrapped on the
//! first non-doc statement and never logged.

use super::error::SecretExportError;
use crate::host::HostCtx;
use std::path::Path;
// Tauri types serve only the cfg-gated IPC wrapper (task 79, Option B).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{AppHandle, Runtime};
use zeroize::Zeroizing;

/// Reject a destination that is unusable OR resolves inside `app_data` (which
/// contains `vaults/`). The load-bearing guard: `dest` is WebView-supplied
/// (TB6), so without the containment check a compromised WebView could bypass
/// the save dialog and overwrite `vault.meta` / `.myn` blobs — the exact
/// arbitrary-write the removed fs scope allowed. Mirrors
/// `export::validate_destination`; the predicate itself is shared
/// (`myne_format::dest_guard`), so this is no longer a third copy.
///
/// **It fails CLOSED.** The first version wrapped the containment half in
/// `if let Ok(canon_app_data) = app_data.canonicalize()` with no `else`, so a
/// root that could not be canonicalized read as "nothing to compare against"
/// and the guard vanished in the one state where it is still needed. Any
/// refusal now maps to the same `InvalidDestination` the caller already
/// handles — the user sees "pick another location", which is the right advice
/// in every one of those states.
fn validate_secret_destination(dest: &Path, app_data: &Path) -> Result<(), SecretExportError> {
    // `app_data` arrives already resolved (the host maps its resolution failure
    // to `Err` before this point), so the only unresolved-root case is a
    // canonicalize failure, which the helper refuses.
    let roots = [Ok(app_data.to_path_buf())];
    myne_format::dest_guard::containment_refused(dest, &roots)
        .map_err(|_| SecretExportError::InvalidDestination)
}

/// Write the secret `contents` to the user-chosen `path` returned by the save
/// dialog. Rejects any destination inside the app-data / vault tree.
pub async fn save_secret_text_from_host(
    host: &dyn HostCtx,
    path: String,
    contents: String,
) -> Result<(), SecretExportError> {
    // First non-doc statement: bound the secret's lifetime to a Zeroizing wrapper.
    let contents = Zeroizing::new(contents);
    let dest = std::path::PathBuf::from(&path);

    let app_data = host.app_data_dir().map_err(|_| SecretExportError::Io {
        io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
    })?;
    validate_secret_destination(&dest, &app_data)?;

    // User destination → `atomic_write_unclobbered_private`: randomized temp
    // name (never truncates a pre-existing `<target>.tmp` at a directory the
    // USER owns) AND create-time mode `0600`. Both properties are required
    // here and neither helper alone supplies both — this command's payload is
    // a bearer credential (the 24-word recovery phrase, the account number),
    // so a umask-default `0644` would leave it readable by every other local
    // account on the machine. `replace = true`: the OS save dialog already
    // confirmed any overwrite of the chosen file.
    crate::task::run_blocking(move || {
        crate::atomic_write::atomic_write_unclobbered_private(&dest, contents.as_bytes(), true)
    })
    .await
    .map_err(|_| SecretExportError::Io {
        io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
    })?
    .map_err(|e| SecretExportError::Io {
        io_error_kind: crate::io_failure_kind::from_io_error_kind(e.kind()),
    })
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn save_secret_text<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    contents: String,
) -> Result<(), SecretExportError> {
    save_secret_text_from_host(&TauriHost::new(app), path, contents).await
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
    fn an_unresolvable_app_data_root_refuses_rather_than_skipping() {
        // The fail-open half this predicate used to have: the containment test
        // sat behind `if let Ok(canon_app_data) = app_data.canonicalize()` with no
        // `else`, so a root that could not be canonicalized read as "nothing to
        // compare against" and the write went through with only the
        // parent-directory rule left. A path running THROUGH a regular file is
        // the portable way to construct a non-`NotFound` canonicalize failure
        // (ENOTDIR); a root that simply does not exist is deliberately skipped,
        // which is asserted at the shared predicate.
        let out = ScopedTempDir::new("secret-export-unresolvable-out").expect("tempdir");
        let broken = ScopedTempDir::new("secret-export-unresolvable").expect("tempdir");
        let regular_file = broken.path().join("not-a-directory");
        std::fs::write(&regular_file, b"file").expect("seed");
        let unresolvable_app_data = regular_file.join("subdir");
        let dest = out.path().join("kit.txt");

        assert_eq!(
            validate_secret_destination(&dest, &unresolvable_app_data),
            Err(SecretExportError::InvalidDestination),
            "a root that cannot be canonicalized must refuse, not skip"
        );
        assert!(!dest.exists(), "nothing may be written");
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
