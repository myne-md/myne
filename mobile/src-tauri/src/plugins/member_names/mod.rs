// SPDX-License-Identifier: AGPL-3.0
//! `member-names` plugin: mobile shim over the shared
//! [`myne_core::plugins::member_names`] store.
//!
//! The B2B member display-name store (`vault.member-names`, magic `MYO5`;
//! `decisions/protocol/0666`). The codec, group-tier key resolution, sync
//! classification and the three command cores live in `myne-core`, shared with
//! desktop. This crate keeps only the per-client wiring: [`init()`] +
//! `generate_handler!` + the `member-names:default` capability entry. Same split the
//! `sync` / `notes` / `prefs` / `quick_unlock` shims use, so the phone has no second
//! implementation of the store to audit.
//!
//! ## Why mobile needs it at all
//!
//! The accept step (myne-md/myne#851 task 14) lands a member vault, and task 15's
//! name step is what stops the phone leaving onboarding unnamed. The name that step
//! writes is a SIGNED row, and the only writer of one is
//! `member_names_set_mine`: there is no second way in, because the row is keyed by
//! the session's own person id and signed by the session's own person key. So the
//! plugin is the name step's whole substrate, not a nice-to-have beside it.
//!
//! ## Capability ACL
//!
//! `member-names:default` bundles the three commands (`member_names_list` /
//! `member_names_set_mine` / `member_names_clear_mine`), exactly the desktop bundle.
//! Every command is `Slot::Unlocked`-gated, and the two writers can only write the
//! CALLER'S OWN row (see the store: the key and the signer both come from the
//! session), so no grant here carries authority over another member's name. Like the
//! other write-capable plugins, v0.2 multi-window MUST NOT grant
//! `allow-member-names-set-mine` or `allow-member-names-clear-mine` to a non-main
//! window.
//!
//! **The ACL is registered, granted and reachable in full, but only one of the three
//! has a mobile caller today.** `mobile/src/lib/memberNames.ts` wraps
//! `member_names_set_mine` for the onboarding name step;
//! `scripts/check-ipc-binding-callers.mjs` refuses a binding with no production
//! caller, so `member_names_list` and `member_names_clear_mine` have deliberately NO
//! TypeScript binding on this side. That is not a hole: mobile's Members panel reads
//! names through `sync_list_roster`, which resolves each row's name server-side via
//! `resolve_member_name`, and post-onboarding name EDITING is out of task 15's scope
//! by its own task body. Both commands stay registered and granted so the surfaces
//! that arrive later do not need a Rust change to use them, the same posture the
//! desktop shim takes toward `member_names_list`.
//!
//! See: mobile/AGENTS.md, and the main repo's `src-tauri/AGENTS.md`
//! "Capability ACL" / "Plugin pattern".

// The command core lives in `myne-core` (shared with desktop). Re-exported so
// `crate::plugins::member_names::commands::…` paths resolve; the `init()` wiring is
// client-side, like `sync` / `themes` / `prefs`.
pub use myne_core::plugins::member_names::commands;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the mobile `member-names` plugin.
///
/// Binds the member display-name commands over the encrypted `vault.member-names`
/// blob. Holds NO plugin-private state: every command borrows the
/// `VaultRuntimeState` singleton (registered by `vault_unlock::init`, shared with
/// desktop) and resolves the active vault dir per call.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("member-names")
        .invoke_handler(tauri::generate_handler![
            commands::member_names_list,
            commands::member_names_set_mine,
            commands::member_names_clear_mine,
        ])
        .build()
}
