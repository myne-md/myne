// SPDX-License-Identifier: AGPL-3.0-only
//! Tauri-layer error type for the `share_import` (share-import staging queue)
//! plugin.
//!
//! Closed, `serde`-tagged set hand-mirrored on the TS side. No `String` field
//! reaches the frontend; OS / codec detail is reduced to coarse variants per the
//! secret-handling logging discipline. A corrupt / foreign / oversize queue
//! entry is NOT surfaced as an error — it is silently dropped by
//! [`super::commands::drain_in_dir`] / [`super::commands::seal_share_in_dir`] (an
//! entry that cannot become an attachment is discarded), so this enum only
//! carries genuine backend/IO failures.

use crate::io_failure_kind::IoFailureKind;
use serde::Serialize;
use thiserror::Error;

/// Single error type returned across IPC by the `share_import` plugin.
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum ShareImportError {
    /// No device-local secure storage is available on this platform (e.g. an
    /// Android build without the Keystore provider wired yet), so the queue
    /// cannot be sealed/opened. On iOS this never fires.
    #[error("device-local secure storage unavailable")]
    HardwareUnavailable,
    /// Filesystem failure (bounded kind; no path string leaked).
    #[error("share-import io failure")]
    Io(IoFailureKind),
    /// Opaque backend failure (keychain/Keystore API, CSPRNG, or blob codec).
    #[error("share-import backend failure")]
    Backend,
}
