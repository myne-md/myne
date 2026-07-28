// SPDX-License-Identifier: AGPL-3.0
//! `workspace` plugin core — persistence of the editor's pane tree (the
//! `vault.workspace` blob, `MYW1`, `protocol.md` § 9.7): `workspace_read`,
//! `workspace_write` and the RAM-only `workspace_stage`.
//!
//! Both file-touching commands are Slot::Unlocked-gated and borrow the existing
//! `VaultRuntimeState` singleton; the descriptor is the frontend's serialized
//! pane tree (open tabs + layout + cursors), sealed opaque under
//! `session_state_key = DeriveSubkey(root_key, SessionStateKey)`.
//!
//! # Write cadence is part of the threat model, not a UX preference
//!
//! The blob is written on GRACEFUL EXIT ONLY — lock, auto-lock grace, quit —
//! and never on a tab switch (design grill 2026-06-01 Q1). Written per switch,
//! `vault.workspace`'s mtime would become a high-resolution log of when the
//! user was reading which note, sitting in plaintext metadata beside the
//! encrypted vault. `workspace_stage` exists precisely so the frontend can keep
//! the backend's copy current without touching the file: staging is RAM, the
//! flush is exit.
//!
//! **This holds identically on web** (phase3-web-client task 65). A browser has
//! more exit shapes than a window does — `pagehide`, `visibilitychange`, a
//! closed tab — but the rule is unchanged: stage on layout change, write once on
//! the way out.
//!
//! Extracted from the desktop crate into `myne-core` (the
//! `graph_layout`/`snapshots`/`vault_indices` precedent) so the web client can
//! restore a layout at all. Like every shared plugin core, `init()` is
//! per-client: each host registers the same three commands under its own
//! capability grant.
//!
//! See: `src-tauri/CLAUDE.md` "Secret-handling logging discipline".

pub mod commands;
pub mod error;
