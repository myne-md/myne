// SPDX-License-Identifier: AGPL-3.0
//! `workspace` command cores (MYND-166; ported to `myne-core` by
//! phase3-web-client task 65).
//!
//! - [`workspace_read_from_host`] — Slot::Unlocked-gated read of the
//!   `vault.workspace` blob; returns the opaque descriptor string, or
//!   `None` (→ frontend default single empty pane) on absent / AEAD-fail /
//!   unsupported-format / parse-fail per `docs/spec/protocol.md` § 9.7.4.
//! - [`workspace_write_from_host`] — Slot::Unlocked-gated write of the
//!   descriptor, serialized opaque by the codec, under a per-plugin write mutex.
//! - [`workspace_stage`] — RAM-only staging; see the module doc on why the file
//!   write is exit-only.
//!
//! The descriptor is the client's serialized pane-tree (note IDs + layout +
//! cursor offsets) — AS3-Sensitive. It crosses IPC as a `String`; the
//! Zeroizing-wrap + drop discipline (`src-tauri/CLAUDE.md` "Secret-handling
//! logging discipline", Plaintext-IPC pattern) applies.
//!
//! # What the port changed, and what it deliberately did not
//!
//! `MYW1`, the `"session-state-key"` subkey role and the AAD binding of
//! `account_number_hash` are untouched — a desktop-written blob is a
//! web-readable blob and the reverse, which is the only acceptable outcome for
//! a format two clients share. What moved is where the BYTES come from:
//! `std::fs` → [`crate::vault_io::VaultIo`], so the same code reaches a
//! filesystem on desktop and OPFS in a browser.

use super::error::{WorkspaceReadError, WorkspaceWriteError};
use crate::host::HostCtx;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::vault_io::VaultIo;
use protocol::{
    decode_workspace_blob, derive_subkey, encode_workspace_blob, parse_vault_meta_any, SubkeyRole,
    WorkspaceBlobError, VAULT_META_ACCOUNT_HASH_LEN,
};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
// Tauri types serve only the cfg-gated wrappers (phase3-web-client task 79,
// Option B); gated alongside them so a `--no-default-features` build does not
// trip on an import of a dependency that is not there.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{AppHandle, Runtime, State};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

/// Per-plugin write serialization (mirrors the prefs plugin).
fn write_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

/// Resolve the ACTIVE (sole-`Unlocked`) vault's root `vaults/<id>/`. Mirrors
/// `graph_layout`/`prefs`/`search`: the workspace blob always belongs to the
/// unlocked vault, so it resolves via the active id — NOT the retired
/// single-vault `<app_data_dir>/vault/` path.
fn vault_dir_from_host(
    host: &dyn HostCtx,
    active_id: Option<crate::vault_id::VaultId>,
) -> std::io::Result<PathBuf> {
    crate::paths::active_vault_root_io_from_host(host, active_id)
}

/// Read `vault.meta` and return its `account_number_hash` (offset 6). The
/// caller passes the parse-error constructor so read/write land on their own
/// error surface; an IO failure flows through `E: From<IoFailureKind>`.
async fn read_account_number_hash<E>(
    io: &dyn VaultIo,
    meta_path: &Path,
    on_parse_err: impl FnOnce() -> E,
) -> Result<[u8; VAULT_META_ACCOUNT_HASH_LEN], E>
where
    E: From<crate::io_failure_kind::IoFailureKind>,
{
    // `vault.meta` is a double-buffered singleton on the web store (task 18), so
    // "read it" means "the newest copy that PARSES". Native is unchanged by
    // construction: `read_candidates` yields one element there.
    match crate::singleton::open_newest(io, meta_path, |candidate| {
        parse_vault_meta_any(candidate).map(|m| m.account_number_hash)
    })
    .await
    {
        Ok(hash) => Ok(hash),
        Err(crate::singleton::OpenOutcome::Absent) => {
            Err(crate::io_failure_kind::IoFailureKind::NotFound.into())
        }
        Err(crate::singleton::OpenOutcome::Io(kind)) => Err(kind.into()),
        Err(crate::singleton::OpenOutcome::Undecodable(_)) => Err(on_parse_err()),
    }
}

/// Closed-enum mapping from `WorkspaceBlobError` to a static log tag.
fn workspace_blob_error_kind(e: &WorkspaceBlobError) -> &'static str {
    match e {
        WorkspaceBlobError::HeaderTooShort => "header_too_short",
        WorkspaceBlobError::MagicMismatch => "magic_mismatch",
        WorkspaceBlobError::ProtocolVersionMismatch => "protocol_version_mismatch",
        WorkspaceBlobError::FormatUnsupported => "format_unsupported",
        WorkspaceBlobError::CiphertextLenOverflow => "ciphertext_len_overflow",
        WorkspaceBlobError::CiphertextTruncated => "ciphertext_truncated",
        WorkspaceBlobError::CannotDecrypt => "aead_fail",
        WorkspaceBlobError::PlaintextTooLarge => "plaintext_too_large",
        WorkspaceBlobError::RandomnessUnavailable => "randomness_unavailable",
        _ => "other_workspace_blob_error",
    }
}

/// Read `vault.workspace` and decode under `session_state_key` + AAD.
/// Returns `None` on any failure (absent / AEAD-fail / unsupported /
/// non-UTF-8) per spec § 9.7.4 — the caller restores the default workspace.
async fn read_or_none(
    io: &dyn VaultIo,
    workspace_path: &Path,
    session_state_key: &[u8; 32],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> Option<String> {
    // Through the SINGLETON fallback (myne#301): `VaultIo::read` answers with the
    // newest structurally intact candidate, so on the web client a slot torn
    // mid-write discards the intact copy beside it and the workspace silently
    // resets to default. The caller's own decode is the verifier.
    use crate::singleton::{open_newest_and_sweep, OpenOutcome};
    let bytes = match open_newest_and_sweep(io, workspace_path, |b: &[u8]| {
        decode_workspace_blob(session_state_key, account_number_hash, b)
            .ok()
            .and_then(|pt| String::from_utf8(pt.to_vec()).ok())
            .ok_or(())
    })
    .await
    {
        Ok(text) => return Some(text),
        Err(OpenOutcome::Absent) => return None,
        Err(OpenOutcome::Io(io_kind)) => {
            tracing::warn!(
                event = "workspace_io_failed",
                stage = "read",
                io_kind = ?io_kind,
                "vault.workspace read failed; falling back to default"
            );
            return None;
        }
        // Fall through to the existing per-cause logging below, which
        // distinguishes AEAD failure from a non-UTF-8 payload. Re-reading the
        // newest copy for that is fine: nothing decoded, so nothing was swept.
        Err(OpenOutcome::Undecodable(())) => match io.read(workspace_path).await {
            Ok(b) => b,
            Err(_) => return None,
        },
    };
    match decode_workspace_blob(session_state_key, account_number_hash, &bytes) {
        Ok(plaintext) => match String::from_utf8(plaintext.to_vec()) {
            Ok(s) => Some(s),
            Err(_) => {
                tracing::warn!(
                    event = "workspace_decode_failed",
                    reason = "non_utf8",
                    "vault.workspace plaintext not UTF-8; falling back to default"
                );
                None
            }
        },
        Err(cause) => {
            tracing::warn!(
                event = "workspace_decode_failed",
                reason = workspace_blob_error_kind(&cause),
                "vault.workspace decode failed; falling back to default"
            );
            None
        }
    }
}

/// Read the persisted editor workspace descriptor. `Ok(None)` means "no
/// restorable workspace" → the frontend opens a single empty pane.
///
/// Host-taking inner. Compiles on every target; differs from the wrapper by the
/// path-resolution line alone.
pub async fn workspace_read_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<Option<String>, WorkspaceReadError> {
    let dir = vault_dir_from_host(host, state.active_vault_id().await)
        .map_err(WorkspaceReadError::from)?;
    workspace_read_with_dir(io, &dir, state).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn workspace_read<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Option<String>, WorkspaceReadError> {
    workspace_read_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
}

/// Testable core of [`workspace_read_from_host`].
pub async fn workspace_read_with_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
) -> Result<Option<String>, WorkspaceReadError> {
    let (root_key, _vmh) = state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .ok_or(WorkspaceReadError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash(io, &vault_dir.join("vault.meta"), || {
        WorkspaceReadError::InvalidVaultMeta
    })
    .await?;
    let session_state_key = derive_subkey(&root_key, SubkeyRole::SessionStateKey);

    Ok(read_or_none(
        io,
        &vault_dir.join("vault.workspace"),
        &session_state_key,
        &account_number_hash,
    )
    .await)
}

/// Persist the editor workspace descriptor (opaque JSON string from the
/// frontend). Called on graceful exit (lock / auto-lock grace / quit).
///
/// The `Zeroizing` wrap stays the FIRST non-doc statement, exactly as in the
/// command it replaces: the descriptor carries note ids, and every early-return
/// path must wipe it.
pub async fn workspace_write_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    descriptor: String,
) -> Result<(), WorkspaceWriteError> {
    let descriptor = Zeroizing::new(descriptor);
    let dir = vault_dir_from_host(host, state.active_vault_id().await)
        .map_err(WorkspaceWriteError::from)?;
    workspace_write_with_dir(io, &dir, state, &descriptor).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn workspace_write<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    descriptor: String,
) -> Result<(), WorkspaceWriteError> {
    workspace_write_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        descriptor,
    )
    .await
}

/// Testable core of [`workspace_write_from_host`].
pub async fn workspace_write_with_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    descriptor: &str,
) -> Result<(), WorkspaceWriteError> {
    let _write_guard = write_mutex().lock().await;

    let (root_key, _vmh) = state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .ok_or(WorkspaceWriteError::SlotNotUnlocked)?;

    let account_number_hash = read_account_number_hash(io, &vault_dir.join("vault.meta"), || {
        WorkspaceWriteError::InvalidVaultMeta
    })
    .await?;
    let session_state_key = derive_subkey(&root_key, SubkeyRole::SessionStateKey);

    let blob_bytes = encode_workspace_blob(
        &session_state_key,
        &account_number_hash,
        descriptor.as_bytes(),
    )
    .map_err(|_| WorkspaceWriteError::WorkspaceEncodeFailed)?;

    io.write(
        &vault_dir.join("vault.workspace"),
        &blob_bytes,
        crate::vault_io::WriteOpts::default(),
    )
    .await
    .map_err(WorkspaceWriteError::from)?;

    tracing::info!(event = "workspace_written");
    Ok(())
}

/// Closed-enum mapping from `WorkspaceWriteError` to a static log tag
/// (DENY-list clean; no path / key material).
fn workspace_write_error_kind(e: &WorkspaceWriteError) -> &'static str {
    match e {
        WorkspaceWriteError::SlotNotUnlocked => "slot_not_unlocked",
        WorkspaceWriteError::Io { .. } => "io",
        WorkspaceWriteError::InvalidVaultMeta => "invalid_vault_meta",
        WorkspaceWriteError::WorkspaceEncodeFailed => "encode_failed",
    }
}

/// In-RAM staging slot for the latest workspace descriptor the frontend
/// pushed on its last layout change. Held opaque in a `Zeroizing` wrapper
/// (note IDs are AS3-Sensitive). Staging touches RAM ONLY — never the file —
/// so `vault.workspace`'s mtime stays a low-resolution lock/quit signal (the
/// 2026-06-01 grill); the staged value is flushed to disk solely on exit.
///
/// A `std::sync::Mutex` (not `tokio`) so [`clear_staged_descriptor`] can wipe
/// it synchronously from the lock-teardown sites — the guard is only ever held
/// for a trivial assign/clone, never across an `.await`.
///
/// **One slot per process, and a browser tab is a process.** The single-tab
/// lock (task 21) means one live client per origin, so this stays a singleton
/// on web exactly as it is on desktop.
fn staged_descriptor() -> &'static std::sync::Mutex<Option<Zeroizing<String>>> {
    static S: OnceLock<std::sync::Mutex<Option<Zeroizing<String>>>> = OnceLock::new();
    S.get_or_init(|| std::sync::Mutex::new(None))
}

/// Stage the latest workspace descriptor in RAM (no file write, no slot gate
/// — it is just a string until exit). This is the persistence path for app
/// QUIT (Cmd+Q / app-menu Quit), which fires `RunEvent::ExitRequested` but
/// NOT the window's `onCloseRequested` (the frontend's other persist hook),
/// so without staging a quit would silently drop the layout.
///
/// On web the equivalent is a closed tab: `pagehide` gives the page one
/// synchronous moment and no time for a KDF-free-but-still-async encrypt +
/// OPFS write, so the browser client stages on layout change too and flushes
/// from the lock path.
pub fn stage_descriptor(descriptor: String) {
    let descriptor = Zeroizing::new(descriptor);
    *staged_descriptor()
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(descriptor);
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn workspace_stage(descriptor: String) -> Result<(), WorkspaceWriteError> {
    stage_descriptor(descriptor);
    Ok(())
}

/// Clear the staged descriptor (drop wipes the `Zeroizing` → erases the AS3
/// note-ids). Wired into EVERY lock-teardown site via
/// `VaultLifecycleHooks::clear_staged_descriptor`, so the open-tab metadata
/// never outlives the slot (threat-model A6) and a vault switch (lock A →
/// unlock B) can't leave A's layout staged to flush into B's vault. Sync +
/// infallible (poison-tolerant; the guard is only ever held for a trivial
/// assign).
pub fn clear_staged_descriptor() {
    *staged_descriptor()
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
}

/// Take the staged descriptor, leaving the slot empty.
///
/// Used by the exit flush. Taking rather than cloning is deliberate: a flush
/// that succeeded has no reason to keep an AS3-Sensitive copy in RAM, and one
/// that failed has no retry path — the exit is already happening.
pub fn take_staged_descriptor() -> Option<Zeroizing<String>> {
    staged_descriptor()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
}

/// Flush the staged descriptor to `vault.workspace` on graceful exit
/// (best-effort). No-op when nothing was staged or the slot is locked (the
/// write requires the root key). Resolves the ACTIVE vault root.
pub async fn persist_workspace_on_exit_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) {
    let Some(descriptor) = take_staged_descriptor() else {
        return;
    };
    let Ok(dir) = vault_dir_from_host(host, state.active_vault_id().await) else {
        return;
    };
    if let Err(e) = workspace_write_with_dir(io, &dir, state, &descriptor).await {
        tracing::warn!(
            event = "workspace_persist_on_exit_skipped",
            reason = workspace_write_error_kind(&e),
        );
    }
}

/// Desktop entry point for the exit flush, called from the
/// `RunEvent::ExitRequested` handler.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
pub async fn persist_workspace_on_exit<R: Runtime>(app: &AppHandle<R>, state: &VaultRuntimeState) {
    persist_workspace_on_exit_from_host(
        &TauriHost::new(app.clone()),
        &crate::vault_io::StdVaultIo,
        state,
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::vault_unlock::state::{fixture_unlocked_with_keys, test_vault_id};
    use crate::test_support::ScopedTempDir;
    use protocol::VAULT_META_ACCOUNT_HASH_LEN;

    const ROOT_BYTE: u8 = 0x42;
    const HASH_BYTE: u8 = 0x7c;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    /// The REAL native arm, not a double. The claim this port makes is that one
    /// code path serves both targets; a fake here would only prove the
    /// signature compiles.
    const IO: crate::vault_io::StdVaultIo = crate::vault_io::StdVaultIo;

    fn seed_real_vault_meta(dir: &Path, seed_byte: u8) {
        let meta = protocol::VaultMeta {
            account_number_hash: [seed_byte; VAULT_META_ACCOUNT_HASH_LEN],
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [1u8; 16],
            random_salt_recovery: [2u8; 16],
            nonce_password_wrap: [3u8; 24],
            enc_root_key_password: [4u8; 64],
            nonce_recovery_wrap: [5u8; 24],
            enc_root_key_recovery: [6u8; 64],
            items_key_id: [7u8; 16],
            items_key_nonce: [8u8; 24],
            enc_items_key: [9u8; 64],
            membership: None,
        };
        std::fs::write(
            dir.join("vault.meta"),
            protocol::serialize_vault_meta(&meta),
        )
        .expect("seed vault.meta");
    }

    async fn unlocked_vault() -> (ScopedTempDir, VaultRuntimeState) {
        let tmp = ScopedTempDir::new("workspace-it").expect("scoped tempdir");
        seed_real_vault_meta(tmp.path(), HASH_BYTE);
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(
                test_vault_id(),
                fixture_unlocked_with_keys(ROOT_BYTE, 0x99, 1),
            )
            .await;
        (tmp, state)
    }

    #[test]
    fn a_written_descriptor_reads_back_verbatim() {
        rt().block_on(async {
            let (tmp, state) = unlocked_vault().await;
            let descriptor = r#"{"slots":[{"id":"a","root":{"kind":"leaf"}}],"activeId":"a"}"#;
            workspace_write_with_dir(&IO, tmp.path(), &state, descriptor)
                .await
                .expect("write");
            let got = workspace_read_with_dir(&IO, tmp.path(), &state)
                .await
                .expect("read");
            assert_eq!(got.as_deref(), Some(descriptor));
        });
    }

    #[test]
    fn an_absent_blob_reads_as_the_default_workspace_rather_than_an_error() {
        // §9.7.4's fall-back semantic. The distinction matters on web more than
        // on desktop: OPFS is evictable, so "absent" is a state a healthy
        // client reaches, and surfacing it as an error would turn a lost layout
        // into a lost session.
        rt().block_on(async {
            let (tmp, state) = unlocked_vault().await;
            let got = workspace_read_with_dir(&IO, tmp.path(), &state)
                .await
                .expect("read");
            assert_eq!(got, None);
        });
    }

    #[test]
    fn a_corrupt_blob_reads_as_the_default_workspace_rather_than_an_error() {
        rt().block_on(async {
            let (tmp, state) = unlocked_vault().await;
            std::fs::write(
                tmp.path().join("vault.workspace"),
                b"not a MYW1 blob at all",
            )
            .expect("seed garbage");
            let got = workspace_read_with_dir(&IO, tmp.path(), &state)
                .await
                .expect("read");
            assert_eq!(got, None);
        });
    }

    #[test]
    fn another_vaults_blob_does_not_decrypt() {
        // The AAD binds `account_number_hash`, so vault A's layout is not
        // readable under vault B — and the failure is the same silent fall-back
        // as any other decode failure, never a distinguishing error (§6.4).
        rt().block_on(async {
            let (a, state_a) = unlocked_vault().await;
            workspace_write_with_dir(&IO, a.path(), &state_a, "{\"slots\":[]}")
                .await
                .expect("write");

            let b = ScopedTempDir::new("workspace-other").expect("scoped tempdir");
            seed_real_vault_meta(b.path(), HASH_BYTE ^ 0xff);
            std::fs::copy(
                a.path().join("vault.workspace"),
                b.path().join("vault.workspace"),
            )
            .expect("copy blob");

            let got = workspace_read_with_dir(&IO, b.path(), &state_a)
                .await
                .expect("read");
            assert_eq!(got, None);
        });
    }

    #[test]
    fn a_locked_slot_refuses_both_directions() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("workspace-locked").expect("scoped tempdir");
            seed_real_vault_meta(tmp.path(), HASH_BYTE);
            let state = VaultRuntimeState::default();
            assert!(matches!(
                workspace_read_with_dir(&IO, tmp.path(), &state).await,
                Err(WorkspaceReadError::SlotNotUnlocked)
            ));
            assert!(matches!(
                workspace_write_with_dir(&IO, tmp.path(), &state, "{}").await,
                Err(WorkspaceWriteError::SlotNotUnlocked)
            ));
        });
    }

    #[test]
    fn staging_never_touches_the_file() {
        // The whole reason `workspace_stage` exists: `vault.workspace`'s mtime
        // must stay a lock/quit signal, not a log of when the user switched
        // tabs. A staging call that wrote through would defeat the design
        // silently, and nothing else in the system would notice.
        rt().block_on(async {
            let (tmp, _state) = unlocked_vault().await;
            clear_staged_descriptor();
            stage_descriptor("{\"slots\":[]}".to_string());
            assert!(!tmp.path().join("vault.workspace").exists());
            assert_eq!(
                take_staged_descriptor().as_deref().map(|s| s.as_str()),
                Some("{\"slots\":[]}")
            );
        });
    }

    #[test]
    fn clearing_the_staged_descriptor_leaves_nothing_to_flush() {
        // Lock teardown (A6): the open-tab set must not outlive the slot, and a
        // vault switch must not leave vault A's layout staged to flush into
        // vault B.
        clear_staged_descriptor();
        stage_descriptor("{\"slots\":[\"a\"]}".to_string());
        clear_staged_descriptor();
        assert!(take_staged_descriptor().is_none());
    }

    #[test]
    fn the_exit_flush_writes_the_staged_descriptor_and_empties_the_slot() {
        rt().block_on(async {
            let (tmp, state) = unlocked_vault().await;
            clear_staged_descriptor();
            let descriptor = r#"{"slots":[{"id":"z"}],"activeId":"z"}"#;
            stage_descriptor(descriptor.to_string());

            let staged = take_staged_descriptor().expect("staged");
            workspace_write_with_dir(&IO, tmp.path(), &state, &staged)
                .await
                .expect("flush");

            let got = workspace_read_with_dir(&IO, tmp.path(), &state)
                .await
                .expect("read");
            assert_eq!(got.as_deref(), Some(descriptor));
            assert!(take_staged_descriptor().is_none());
        });
    }
}
