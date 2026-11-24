// SPDX-License-Identifier: AGPL-3.0-only
//! The `NC05` CRDT note-type decode path, host-free.

pub mod crdt_decode;
pub mod decode;
#[cfg(not(target_arch = "wasm32"))]
pub mod export_mtime;
pub mod note_id;
pub mod title_extract;
