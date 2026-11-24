// SPDX-License-Identifier: AGPL-3.0-only
//! Tauri-layer error type for the `captures` (pending-capture queue) plugin.
//!
//! Closed, `serde`-tagged set hand-mirrored on the TS side. No `String` field
//! reaches the frontend; OS / codec detail is reduced to coarse variants per the
//! secret-handling logging discipline (`../../AGENTS.md`). Note that a corrupt /
//! foreign / non-UTF-8 queue entry is NOT surfaced as an error — it is silently
//! dropped by [`super::commands::take_pending`] (a queue entry that cannot become
//! a note is discarded), so this enum only carries genuine backend/IO failures.

use crate::io_failure_kind::IoFailureKind;
use serde::Serialize;
use thiserror::Error;

/// Single error type returned across IPC by the `captures` plugin.
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum CaptureError {
    /// No device-local keychain is available on this platform (non-Apple), so
    /// the queue cannot be sealed/opened. On iOS this never fires.
    #[error("device-local secure storage unavailable")]
    HardwareUnavailable,
    /// Filesystem failure (bounded kind; no path string leaked).
    #[error("captures io failure")]
    Io(IoFailureKind),
    /// An arrived watch audio chunk exceeded the codec's plaintext cap. Refused
    /// BEFORE any sealing (and before the file is read into RAM), never
    /// truncated: a partial chunk would silently lose audio.
    #[error("watch audio chunk exceeds the size cap")]
    ChunkTooLarge,
    /// Opaque backend failure (keychain API, CSPRNG, or blob codec).
    #[error("captures backend failure")]
    Backend,
}
