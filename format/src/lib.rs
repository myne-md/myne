// SPDX-License-Identifier: AGPL-3.0
//! `myne-format` — the on-disk format crate.
//!
//! The host-free half of Myne's on-disk format, extracted so the
//! `myne-decrypt` CLI can read a vault without pulling `myne-core`'s TLS stack
//! and ML runtime. It carries:
//!
//! * the `VaultIo` filesystem seam (trait + supporting types only; the native
//!   and wasm implementations stay in their host crates);
//! * the closed `IoFailureKind` error categorization;
//! * the export-naming vocabulary (filename sanitization, dedup, embed
//!   rewrite) plus the form-C embed span scanner it depends on;
//! * the NC05 note decode path (task 2) and the MYB1 backup-container read
//!   half (task 3).
//!
//! Native-only by design: consumed by the desktop client and the CLI. The
//! `VaultIo` trait is carried for the CLI's future use; the export walk and the
//! MYB1 container read half use `std::fs` directly and are gated out of the
//! wasm build (`#[cfg(not(target_arch = "wasm32"))]`).

pub mod atomic_write;
#[cfg(not(target_arch = "wasm32"))]
pub mod backup_container;
pub mod embed_span;
pub mod export_error;
pub mod export_naming;
#[cfg(not(target_arch = "wasm32"))]
pub mod export_walk;
pub mod io_failure_kind;
pub mod notes;
#[cfg(test)]
pub mod test_support;
pub mod vault_io;
