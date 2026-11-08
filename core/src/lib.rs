// SPDX-License-Identifier: AGPL-3.0
//! `myne-core` — shared backend logic for the Myne desktop and mobile clients.
//!
//! Extracted from the desktop `myne_desktop_lib` so the vault / notes / prefs
//! plugin cores live in a single source of truth instead of being copied per
//! client (see `myne-agents/docs/decisions.md` and the `myne-core` extraction plan).
//!
//! Scope:
//! - **Lives here:** host-coupled-but-platform-agnostic plugin cores
//!   (`vault_creation`, `vault_unlock`, `vault_recover`, `vault_change_password`,
//!   `vault_delete`, `notes` CRUD, `prefs`) plus the shared crate-root helpers
//!   (`atomic_write`, `paths`, `vault_registry`, …).
//! - **Stays in each client:** the `tauri::Builder` app wiring,
//!   `generate_handler!` registration, capability/permission ACLs, and the
//!   desktop-only modules (search, spell, snapshots, sync, attachments, backup,
//!   clipper, pdf, workspace), which attach through the
//!   [`hooks::VaultLifecycleHooks`] trait (no-op on mobile, real on desktop).
//!
//! Modules are migrated in phases; this root is intentionally thin until the
//! first module lands.

/// Default auto-lock-on-idle timeout (seconds) applied when the user has
/// stored no preference. The single-source constant the shared
/// `VaultRuntimeState` seeds itself with, and the one every client reaches
/// through [`effective_auto_lock_secs`] rather than by name.
///
/// **PLACEHOLDER, 5 minutes.** Final value owned by MYND-122.
pub const DEFAULT_AUTO_LOCK_SECS: u32 = 300;

/// Hard upper bound on the effective auto-lock timeout, enforced in code.
///
/// This is the **load-bearing edge** of the protective envelope: because it
/// lives in code and not in the replayable `vault.prefs` blob, a replayed /
/// deleted / tampered prefs value can only make auto-lock stricter (≤ this
/// bound), never push it past, so an A4 disk attacker cannot widen the A6
/// exposure window (`threat-model.md` §7; `decisions.md` 2026-05-30).
///
/// **PLACEHOLDER, 60 minutes.** Final value owned by MYND-122.
pub const AUTO_LOCK_CEILING_SECS: u32 = 3600;

/// Lower bound on the effective auto-lock timeout.
///
/// Unlike the ceiling, this is a **UX-comfort floor, not a security edge**,
/// an attacker who *shortens* the timeout only causes more-frequent locking
/// (annoyance), never a privacy break. It exists so an absurdly small replayed
/// value cannot lock the vault mid-keystroke.
///
/// **PLACEHOLDER, 30 seconds.** Final value owned by MYND-122.
pub const MIN_AUTO_LOCK_SECS: u32 = 30;

// Compile-time invariants: a future edit that inverts the bounds or moves
// DEFAULT outside [MIN, CEILING] fails the BUILD, not just a test, and keeps
// the `clamp` min<=max contract sound.
const _: () = assert!(MIN_AUTO_LOCK_SECS > 0);
const _: () = assert!(MIN_AUTO_LOCK_SECS <= AUTO_LOCK_CEILING_SECS);
const _: () = assert!(DEFAULT_AUTO_LOCK_SECS >= MIN_AUTO_LOCK_SECS);
const _: () = assert!(DEFAULT_AUTO_LOCK_SECS <= AUTO_LOCK_CEILING_SECS);

/// Resolve the **effective** auto-lock timeout from the user's stored
/// preference, applying the code-enforced protective envelope.
///
/// `prefs_value` is `PrefsView::auto_lock_seconds`, `None` when the user
/// never chose a timeout OR when the prefs blob was absent / tampered /
/// replayed and collapsed to defaults (`protocol.md` §9.5.5).
///
/// The return type is `u32` (never `Option`): there is **no disabled state**.
///
/// - `None` → [`DEFAULT_AUTO_LOCK_SECS`] (already in range).
/// - `Some(0)` → [`MIN_AUTO_LOCK_SECS`], a sentinel-shaped "off" from a
///   replayed blob cannot disable the lock.
/// - `Some(huge)` → [`AUTO_LOCK_CEILING_SECS`].
/// - `Some(in-range)` → the value unchanged.
///
/// This is the replay-resistance core: every prefs input an A4 disk attacker
/// can produce lands on a protective state.
///
/// **Shared rather than desktop-only since myne-md/myne#479**, and defaulted
/// into [`crate::hooks::VaultLifecycleHooks`] so a client that overrides nothing
/// lands on it. It lived in the desktop crate under a comment saying the policy
/// was desktop-only, which stopped being true once two other clients grew their
/// own auto-locks. Both of their hooks returned
/// `prefs_value.unwrap_or(DEFAULT_AUTO_LOCK_SECS)`, and nothing reported it: the
/// body compiles, satisfies clippy and returns a plausible number.
///
/// **What that cost, stated precisely, because an earlier version of this
/// comment overstated it.** The hook's return value feeds
/// `VaultRuntimeState::auto_lock_timeout_secs`, whose only production reader is
/// the desktop tick loop in `src-tauri/src/auto_lock.rs`. Neither of those two
/// clients compiles it, so no shipped build applied an unclamped number through
/// this path: it was a trap for the next Rust-side reader rather than a live
/// exposure. The exposure that WAS live sat one language over, in the web
/// client's `useIdleAutoLock` call sites, which took the raw pref and treated
/// `null` as "disabled"; `myne-agents/docs/decisions/security/0572` carries both halves.
pub fn effective_auto_lock_secs(prefs_value: Option<u32>) -> u32 {
    prefs_value
        .unwrap_or(DEFAULT_AUTO_LOCK_SECS)
        .clamp(MIN_AUTO_LOCK_SECS, AUTO_LOCK_CEILING_SECS)
}

pub mod atomic_write;
pub mod attachment_nonce;
/// The one decryption-free `content_nonce` reader, shared by every blob family
/// that has one. The generation pair is a required argument, so a
/// single-generation reader cannot be written by accident (myne-md/myne#638).
pub mod content_nonce;
/// The double-buffered container the web client stores singletons in
/// (phase3-web-client task 18) — framing, slot selection, and the write/open
/// algorithm over the [`vault_io`] seam, with the fault-injection points task 19
/// drives. Native builds never reach it: `atomic_write` is their durability
/// contract, and this is what replaces it where no atomic rename exists.
pub mod double_buffer;
/// Named crash states of a double-buffered singleton, as bytes for the web E2E
/// lane's OPFS seeder. Test-support only: the fixtures exist to be written into
/// a browser before an app boots, never by production code.
#[cfg(any(test, feature = "test-support"))]
pub mod double_buffer_fixtures;
pub mod export_naming;
/// The one canonical folder key and the one equal-or-nested folder test, shared
/// by the `ai_excluded_folders` (SYNC-14) clamp in every place that applies it.
pub mod folder_key;
pub mod http;
// The inference seam (myne-md/myne#456): the `Engine` trait, the backend
// registry with its ambient-versus-remote refusal, and the remote-provider arm.
// Behind the default-off `remote-ai` feature so the desktop auditable build
// (`cargo build -p myne-desktop --no-default-features`) keeps containing no
// remote-provider code, which it did while this tree lived inside the
// feature-gated desktop plugin. See the module doc for why that gate is
// load-bearing and what it does not protect.
#[cfg(feature = "remote-ai")]
pub mod inference;
// The process-host seam (phase3-web-client task 79) — what a command core needs
// from its host that is not already an ordinary Rust value. Sibling of `hooks`,
// which is the same idea one axis over (lifecycle side effects).
pub mod hooks;
pub mod host;
// The async-execution seam (phase3-web-client task 80). `spawn_blocking`
// COMPILES for wasm32 and panics at runtime — the same shape as the clock in
// `host`. Both live here so neither can be reached by accident.
pub mod io_failure_kind;
pub mod note_nonce;
pub mod note_txn;
pub mod paths;
pub mod plugins;
pub mod protocol_error_kind;
pub mod rng;
/// The device-local screen-capture override (myne-md/myne#482). One plaintext
/// boolean under `<app_config_dir>` that the startup hook reads BEFORE any
/// vault exists, which is what makes the pre-unlock lockout escapable.
/// Top-level rather than under `plugins/` for the reason `vault_label` is:
/// the plugin, the setup hook and the lock path all consume it and none owns it.
pub mod screen_capture_override;
pub mod task;
// The full-text search engine (MYS1) + its encrypted persistence/reconcile core.
// Top-level (not under `plugins/`) mirroring the desktop `mod search;` it
// replaces. The desktop crate re-exports it via `pub use myne_core::search;`;
// mobile does not wire it (the search-index feed hangs off the desktop-only
// `search_upsert`/`hydrate` hooks, absent in mobile's `NoopHooks`).
/// The account record (the account/vault split, `decisions.md` 2026-09-07): the
/// device-local sealed record that groups vaults under an account. Top-level
/// rather than under `plugins/` for the same reason `vault_label` is: the picker
/// and the account commands both consume it and neither owns it.
pub mod account;
pub mod search;
/// Opening a singleton vault file with crash recovery (phase3-web-client task
/// 18) — the one place that implements "newest copy that verifies wins", so the
/// ~10 singleton readers do not each carry a fallback loop.
pub mod singleton;
pub mod singleton_quiesce;
pub mod snapshot_policy;
pub mod snapshot_store;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
pub mod text;
pub mod vault_id;
/// The filesystem seam (phase3-web-client task 17) — the third and last of the
/// three that make this crate host-independent, alongside [`host`] (paths, events,
/// clock) and [`task`] (blocking execution, timers).
pub mod vault_io;
/// The sealed label store (`MYL1`, `protocol.md` §9.22): the per-vault
/// keychain key and the device-local file that let the LOCKED picker show a
/// vault's real name. Top-level rather than under `plugins/` because four
/// flows consume it (unlock, rename, vault delete, the picker's list) and none
/// of them owns it.
pub mod vault_label;
pub mod vault_meta_hash;
pub mod vault_registry;
pub mod vault_sweep;

#[cfg(test)]
mod auto_lock_envelope_tests {
    use super::{
        effective_auto_lock_secs, AUTO_LOCK_CEILING_SECS, DEFAULT_AUTO_LOCK_SECS,
        MIN_AUTO_LOCK_SECS,
    };

    // The protective-envelope suite, moved here from `src-tauri/src/auto_lock.rs`
    // with the function itself (myne-md/myne#479). It stayed in the desktop
    // crate for one review round after the move, which left that crate importing
    // three constants ONLY its tests used, `-D warnings` called it by name, and
    // left the shared clamp asserted from one client's test module while the
    // other client had just been found not applying it at all. A test for shared
    // code belongs beside the shared code.

    #[test]
    fn none_resolves_to_default() {
        assert_eq!(effective_auto_lock_secs(None), DEFAULT_AUTO_LOCK_SECS);
    }

    #[test]
    fn in_range_value_passes_through_unchanged() {
        assert_eq!(effective_auto_lock_secs(Some(600)), 600);
    }

    #[test]
    fn zero_clamps_up_to_floor_never_disables() {
        // A sentinel-shaped "off" from a replayed / old blob CANNOT disable
        // auto-lock, it clamps to the floor (story 16).
        assert_eq!(effective_auto_lock_secs(Some(0)), MIN_AUTO_LOCK_SECS);
    }

    #[test]
    fn huge_value_clamps_down_to_ceiling() {
        // A replayed long / "off-via-overflow" timeout cannot exceed the
        // ceiling, the A6 exposure window stays bounded (story 16).
        assert_eq!(
            effective_auto_lock_secs(Some(u32::MAX)),
            AUTO_LOCK_CEILING_SECS
        );
        assert_eq!(
            effective_auto_lock_secs(Some(999_999)),
            AUTO_LOCK_CEILING_SECS
        );
    }

    #[test]
    fn every_prefs_input_lands_on_a_protective_state() {
        // The replay-resistance table (stories 16, 18): NO input, absent,
        // sentinel-off, replayed-long, above-ceiling, or any in-between,
        // yields a non-protective (disabled / above-ceiling / below-floor)
        // result. This is the highest-value test for the feature.
        for input in [
            None,
            Some(0),
            Some(1),
            Some(MIN_AUTO_LOCK_SECS),
            Some(DEFAULT_AUTO_LOCK_SECS),
            Some(AUTO_LOCK_CEILING_SECS),
            Some(AUTO_LOCK_CEILING_SECS + 1),
            Some(u32::MAX),
        ] {
            let eff = effective_auto_lock_secs(input);
            assert!(eff >= MIN_AUTO_LOCK_SECS, "{input:?} -> {eff} below floor");
            assert!(
                eff <= AUTO_LOCK_CEILING_SECS,
                "{input:?} -> {eff} above ceiling"
            );
            // Always-on: never zero / disabled.
            assert!(eff > 0, "{input:?} -> {eff} would disable auto-lock");
        }
    }
}
