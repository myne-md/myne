// SPDX-License-Identifier: AGPL-3.0
//! `attachments` plugin core (MYND-169 — the `attachments-crypto-pipeline`
//! sub-feature of the attachments epic).
//!
//! Owns the platform-agnostic attachment pipeline: the `MYA1` blob import /
//! dedup / delete / rename / export cores (`commands`), the `MYC1` catalog
//! read + stray-blob reclaim, the `MYE1` extracted-text cache codec + fold
//! (`text_cache`, with the pure payload types in `extract_types`), the in-RAM
//! reference graph + its reconcile IPC surface (`reconcile` / `reconcile_commands`),
//! the content-type sniffer (`sniff`), the authoritative reference scan behind
//! cleanup (`ref_scan`), and the pure `attachment://` decode+serve core
//! (`scheme_core`). The `MYA1`/`MYC1`/`MYE1` codecs themselves live in
//! `protocol` (shared, unchanged).
//!
//! Extracted from the desktop crate into `myne-core` (shared desktop↔mobile,
//! mobile parity for attachments). Like `notes` / `vault_indices` / `snapshots`,
//! `init()` is per-client: each host builds its own plugin and registers its
//! own command subset (desktop adds voice + eager text-extraction, mobile does
//! not). The desktop-only pieces that stay in the desktop crate:
//!
//! - `extract.rs` — the `lopdf`/`zip`/`quick-xml` text-extraction *producer*
//!   (mobile has no extraction step); the pure payload types moved here
//!   (`extract_types`). `text_cache::backfill_note_attachment_text` and
//!   `commands::attachment_import_with_dir_ext` take the extractor as an
//!   injected closure so this core never pulls those deps.
//! - `voice/` — the `cpal` native-mic capture (a hard mobile blocker).
//! - the Tauri `handle`/`serve` scheme glue + `init()` + the lock-teardown
//!   wipes (`zeroize_attachment_refs` / `abort_active_recording`) which ride
//!   the desktop `hooks::VaultLifecycleHooks` seam.
//!
//! See: `src-tauri/CLAUDE.md` "Secret-handling logging discipline".

pub mod commands;
pub mod error;
pub mod extract_types;
pub mod ocr;
pub mod reconcile;
pub mod reconcile_commands;
pub mod ref_scan;
pub mod scheme_core;
pub mod sniff;
pub mod text_cache;

pub use extract_types::{ExtractStatus, ExtractedText, SourceFormat, MAX_EXTRACTED_TEXT_LEN};
pub use reconcile::AttachmentRefsState;
