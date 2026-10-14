//! `member-names` Tauri plugin: desktop wiring of the shared `myne-core` member
//! display-name store (`vault.member-names`, `MYO5`; protocol.md §9.29,
//! `decisions/protocol/0666`).
//!
//! A thin shim, exactly like the `themes` and `prefs` shims: the command cores and
//! their error enum live in `myne-core` (shared with mobile), and this crate keeps
//! only the `tauri::Builder` `init()` / `generate_handler!` registration plus the
//! capability ACL. The `commands` module is re-exported so any
//! `crate::plugins::member_names::commands::…` path resolves.
//!
//! ## Capability ACL
//!
//! `member-names:default` bundles the three commands (`member_names_list` /
//! `member_names_set_mine` / `member_names_clear_mine`). All are
//! `Slot::Unlocked`-gated, and the two writers can only write the caller's own row:
//! the row is keyed by the session's own person id and signed by the session's own
//! person key, so no grant here carries authority over another member's name. Like
//! the other write-capable plugins, v0.2 multi-window MUST NOT grant
//! `allow-member-names-set-mine` or `allow-member-names-clear-mine` to a non-main
//! window.
//!
//! **The UI caller is the Members-list row editor** (myne-md/myne#851 task 6):
//! `src/lib/memberNames.ts` wraps `member_names_set_mine` / `member_names_clear_mine`
//! for it, and `MemberRosterPanel` renders an inline rename on the caller's own row,
//! the owner's included, and on nobody else's. `member_names_list` has no TypeScript
//! binding on purpose: the roster view already reports each row's resolved name, and
//! the panel cannot key the raw map by its own person id, so wrapping it would add the
//! dead export `scripts/check-ipc-binding-callers.mjs` refuses. It stays registered and
//! granted so that a later read surface needs no Rust change to use it, NOT because
//! one reaches it today: no client calls it, and the accept gate does not either
//! (`MemberNameGate` imports the setter and the error mapper and nothing else).
//! `mobile/src-tauri/src/plugins/member_names/mod.rs` records the same posture for
//! the two commands its own side leaves unwrapped.
//!
//! See: src-tauri/AGENTS.md "Capability ACL", "Plugin pattern".

// The command core lives in `myne-core` (shared with mobile). Re-exported so existing
// `crate::plugins::member_names::commands::…` paths keep resolving; the `init()` wiring
// stays desktop-side (like notes / prefs / themes).
pub use myne_core::plugins::member_names::commands;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `member-names` plugin.
///
/// Binds the member display-name commands over the encrypted `vault.member-names`
/// blob. Holds NO plugin-private state: every command borrows the `VaultRuntimeState`
/// singleton (registered by `vault_unlock::init`) via `tauri::State<...>` and resolves
/// the active vault dir per call. The plugin name in the ACL namespace is
/// `member-names`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("member-names")
        .invoke_handler(tauri::generate_handler![
            commands::member_names_list,
            commands::member_names_set_mine,
            commands::member_names_clear_mine,
        ])
        .build()
}
