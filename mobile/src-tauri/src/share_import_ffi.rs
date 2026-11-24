// SPDX-License-Identifier: AGPL-3.0-only
//! iOS App-Group container seam for the share-import staging queue (SF2,
//! MYND-510). iOS-only.
//!
//! The headless Share Extension (`ios-share/ShareExtension/`) runs in a
//! *separate process* that never holds `root_key` — and, on iOS, cannot
//! practically link the Rust crypto (doing so drags the whole tauri/wry runtime
//! into a ~105 MB extension binary that the app-extension sandbox kills on
//! launch). So the extension stages **plaintext**: it writes each shared file's
//! bytes + a `.meta` sidecar into the shared App-Group container's
//! `pending-shares/staging/` dir (protected at rest by iOS Data Protection),
//! exactly like the Apple-Watch capture receiver's plaintext staging (§9.18.4).
//! The **app** then seals each staged file into the `MYF1` queue and drains it on
//! next open (`drain_pending_shares` → `seal_staged_in_dir`), under the app's own
//! device key — no cross-process keychain sharing.
//!
//! This module is the **reader-side seam**: the app's drain must read the SAME
//! App-Group container the extension wrote, but the shared-core `queue.rs` can't
//! reach `NSFileManager`. So the app resolves the container root here at startup
//! and injects it into the core seam
//! (`queue::set_ios_app_group_container_root`).
//!
//! ⚠️ **DEVICE-VERIFY-PENDING.** The App-Group container needs Apple-Developer
//! provisioning to sign, so the real container path is only confirmed on a signed
//! device build. If `containerURL` returns nil (unprovisioned build) the app
//! falls back to `app_data_dir` and the extension is inert — writer + reader stay
//! consistent, just disabled.

use std::path::PathBuf;

use objc2_foundation::{NSFileManager, NSString};

/// The App-Group identifier shared by the app target and the Share Extension
/// target (declared in both `.entitlements`,
/// `com.apple.security.application-groups`). Load-bearing: it is the sole handle
/// the OS uses to resolve the shared container both processes read/write. Must
/// stay byte-identical to the `group.md.myne.mobile` string in
/// `myne-mobile_iOS.entitlements`, `ShareExtension.entitlements`, and the
/// `appGroupID` constant in `ShareViewController.swift`.
pub const APP_GROUP_ID: &str = "group.md.myne.mobile";

/// Resolve the shared App-Group container root via `NSFileManager`.
///
/// Returns `None` when the App-Group entitlement is absent (`containerURL`
/// yields nil) — an unprovisioned / `--no-default-features` build. The caller
/// then leaves the core seam unset and the queue falls back to `app_data_dir`.
fn app_group_container_dir() -> Option<PathBuf> {
    // Plain Foundation calls (all safe in objc2-foundation 0.3): `defaultManager`
    // is the process-wide shared file manager;
    // `containerURLForSecurityApplicationGroupIdentifier:` returns nil (→ None)
    // when the App-Group entitlement is missing, never a dangling pointer.
    let manager = NSFileManager::defaultManager();
    let group = NSString::from_str(APP_GROUP_ID);
    let url = manager.containerURLForSecurityApplicationGroupIdentifier(&group)?;
    let path = url.path()?;
    Some(PathBuf::from(path.to_string()))
}

/// Resolve the App-Group container at app startup and inject it into the
/// shared-core share-import queue seam so the seal + drain read the extension's
/// `staging/` + `sealed/` dirs. Call once from `lib.rs` `setup()` (iOS-only).
/// Idempotent and safe if the container is unavailable (logs + no-ops →
/// app_data_dir fallback).
pub fn init_app_group_queue() {
    match app_group_container_dir() {
        Some(dir) => {
            tracing::info!(
                stage = "share_import_app_group",
                container = %dir.display(),
                "share-import queue bound to App-Group container"
            );
            myne_core::plugins::share_import::queue::set_ios_app_group_container_root(dir);
        }
        None => {
            // No entitlement (unprovisioned/dev build): the extension can't reach
            // the container either, so falling back to app_data_dir keeps
            // writer+reader agreed.
            tracing::warn!(
                stage = "share_import_app_group",
                "App-Group container unavailable; share-import queue falls back to app_data_dir"
            );
        }
    }
}
