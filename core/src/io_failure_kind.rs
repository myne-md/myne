// SPDX-License-Identifier: AGPL-3.0
//! Repo-wide canonical IO error categorization for Tauri-layer error types.
//!
//! The enum and the mapping live in `myne-format` so the `myne-decrypt` CLI
//! can use the closed kind without pulling this crate. Re-exported here so
//! every existing `crate::io_failure_kind::…` path keeps resolving.

pub use myne_format::io_failure_kind::{from_io_error_kind, IoFailureKind};
