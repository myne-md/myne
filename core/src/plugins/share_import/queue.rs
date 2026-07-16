// SPDX-License-Identifier: AGPL-3.0
//! Device-local on-disk layout for the share-import staging queue.
//!
//! Directories under `<app_data_dir>/pending-shares/` (on iOS, under the shared
//! App-Group container instead):
//! - `sealed/` — `MYF1` blobs (`protocol::share_import_blob`), one per shared
//!   file, named by the hex `share_id`; drained by
//!   [`super::commands::drain_in_dir`].
//! - `staging/` — **iOS only**, plaintext files the Share Extension drops (raw
//!   bytes + a `.meta` sidecar); the app seals each into `sealed/` and deletes
//!   the plaintext on the next drain ([`super::commands::seal_staged_in_dir`]).
//!
//! iOS uses **plaintext-staging** (like the watch-capture staging file, § 9.18.4
//! / § 9.19.4): the extension can't practically link the crypto, so it stages
//! plaintext (protected at rest by iOS Data Protection in the App-Group
//! container) and the app seals. Android has no `staging/` directory — its
//! `ACTION_SEND` receiver hands the bytes to the WebView, which seals straight
//! into `sealed/` (§ 9.19.1); the plaintext is a RAM + WebView-transit transient.
//!
//! The queue is device-global (NOT per-vault): it is created while the vault is
//! locked and drains into whichever vault unlocks first (§ 9.19.4).

use crate::io_failure_kind::from_io_error_kind;
use crate::plugins::share_import::error::ShareImportError;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};

const QUEUE_DIR: &str = "pending-shares";
const SEALED_SUBDIR: &str = "sealed";
const STAGING_SUBDIR: &str = "staging";

/// iOS App-Group container seam (SF2 / MYND-510).
///
/// On iOS the share-import queue is NOT under `<app_data_dir>` — it lives in the
/// shared **App-Group container** (`group.md.myne.mobile`), because the Share
/// Extension is a *separate process* that cannot see the app's private data
/// container. The extension stages plaintext into `<app-group>/pending-shares/
/// staging/` (it links no crypto — §9.19.1); the app's `drain_pending_shares`
/// (this core, run on unlock) seals each into `sealed/` and reads that SAME
/// directory — so writer + reader must agree on the path.
///
/// The App-Group container path is not derivable without the OS
/// (`FileManager.containerURL(forSecurityApplicationGroupIdentifier:)`), so it
/// is resolved once at app startup by the mobile host (which owns the objc2
/// bindings) and injected here via [`set_ios_app_group_container_root`]. Until
/// it is set — a `--no-default-features` / unprovisioned build with no
/// App-Group entitlement, where `containerURL` returns nil and the extension
/// cannot seal either — `base()` falls back to `app_data_dir`, exactly today's
/// behaviour (writer + reader stay consistent because neither uses the group).
///
/// ⚠️ DEVICE-VERIFY-PENDING: the App-Group entitlement needs Apple-Developer
/// provisioning to sign, so the real container path can only be confirmed on a
/// signed device build. See `ios-share/README.md`.
#[cfg(target_os = "ios")]
mod ios_app_group {
    use std::path::PathBuf;
    use std::sync::OnceLock;

    /// The shared App-Group container ROOT (the value returned by
    /// `containerURL(forSecurityApplicationGroupIdentifier: "group.md.myne.mobile")`).
    /// The `pending-shares/` subtree is joined on top by `base()`.
    static ROOT: OnceLock<PathBuf> = OnceLock::new();

    /// Inject the resolved App-Group container root (idempotent — first write
    /// wins; a later call is a no-op). Called once from the mobile host's
    /// `setup()` before any drain can run (drains are unlock-gated, long after
    /// startup).
    pub fn set(root: PathBuf) {
        let _ = ROOT.set(root);
    }

    /// The injected root, if the host resolved and set one.
    pub fn get() -> Option<PathBuf> {
        ROOT.get().cloned()
    }
}

/// Inject the iOS App-Group container root resolved by the mobile host (SF2).
/// See [`ios_app_group`]. No-op is impossible off iOS (the item does not exist),
/// so callers guard with `#[cfg(target_os = "ios")]`.
#[cfg(target_os = "ios")]
pub use ios_app_group::set as set_ios_app_group_container_root;

fn base<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, ShareImportError> {
    // iOS: prefer the shared App-Group container (the Share Extension writes
    // there in a separate process). Falls back to app_data_dir when unset — an
    // unprovisioned build where the extension is inert too, keeping writer +
    // reader consistent.
    #[cfg(target_os = "ios")]
    if let Some(group_root) = ios_app_group::get() {
        return Ok(group_root.join(QUEUE_DIR));
    }
    Ok(crate::paths::app_data_dir(app)
        .map_err(|_| ShareImportError::Backend)?
        .join(QUEUE_DIR))
}

/// `<app_data_dir>/pending-shares/sealed/` — `MYF1` blobs.
pub fn sealed_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, ShareImportError> {
    Ok(base(app)?.join(SEALED_SUBDIR))
}

/// `<app-group-or-app_data_dir>/pending-shares/staging/` — plaintext files the
/// native iOS Share Extension drops (raw bytes + a `.meta` sidecar). The app's
/// seal step ([`super::commands::seal_staged_in_dir`]) frames + seals each into a
/// `MYF1` blob under `sealed/` and deletes the plaintext, on next app open. This
/// mirrors the watch-capture `staging/` plaintext carve-out (§9.18.4 / §9.19.4):
/// the extension can't practically link the crypto, so it stages plaintext
/// (protected by iOS Data Protection in the shared container) and the app seals.
pub fn staging_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, ShareImportError> {
    Ok(base(app)?.join(STAGING_SUBDIR))
}

/// Create `dir` (and parents) if absent.
pub fn ensure_dir(dir: &Path) -> Result<(), ShareImportError> {
    std::fs::create_dir_all(dir).map_err(|e| ShareImportError::Io(from_io_error_kind(e.kind())))
}

/// List the regular files directly in `dir` (non-recursive). A missing dir is
/// an empty list (not an error) — the queue simply has nothing yet.
pub fn list_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_file() {
                out.push(p);
            }
        }
    }
    out
}

/// A `share_id` filename is exactly 32 lowercase-hex chars (16 bytes). Guards
/// `ack` against path traversal and stray non-queue files.
pub fn is_share_id(name: &str) -> bool {
    name.len() == 32 && name.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Lowercase-hex encode (no external dep; matches the queue filename form).
pub fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}
