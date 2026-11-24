// SPDX-License-Identifier: AGPL-3.0-only
//! Atomic file-write helper.
//!
//! The durability mechanics live in `myne-format` so the `myne-decrypt` CLI
//! shares the exact write contract the desktop app uses. Re-exported here so
//! every existing `crate::atomic_write::…` path keeps resolving.

pub use myne_format::atomic_write::{
    atomic_write, atomic_write_private, atomic_write_unclobbered, atomic_write_unclobbered_private,
    finalize_atomic, tmp_path,
};
