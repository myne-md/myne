// SPDX-License-Identifier: AGPL-3.0-only
//! The Worker's session state (phase3-web-client task 12).
//!
//! # What changed, and why it took until now
//!
//! Every command the router answered before this was **stateless**:
//! `device_platform` reads a constant, `vault_status` reads a file. `unlock` is
//! the first that produces something which must outlive the call — the unwrapped
//! `root_key` and `items_key` — so the entry crate needs somewhere to keep it.
//!
//! `myne-core` already owns the shape of that somewhere: [`VaultRuntimeState`]
//! is the same slot map, the same `Slot` state machine and the same auth
//! semaphore the desktop uses. Nothing here re-implements session handling; this
//! module is only the *storage* for one instance of it.
//!
//! # Why a process-global and not a value threaded through `invoke`
//!
//! Tauri manages this exact type as app state and hands each command a
//! `State<'_, VaultRuntimeState>`. There is no equivalent handle in the wasm
//! entry surface — `invoke(cmd, args)` is called from JavaScript and cannot
//! carry a Rust reference — so the state has to be reachable from a static.
//!
//! That is a smaller concession than it looks: **the process-global IS the
//! session boundary here**. One Worker holds one vault's keys, the tab lock
//! (task 21) makes that one Worker per origin, and killing the Worker is how the
//! keys die. On desktop the process plays that role. The scope is the same; only
//! the spelling differs.
//!
//! # Zeroization is unchanged and must stay that way
//!
//! `UnlockedVault`'s `root_key`/`items_key` are `Zeroizing`, so taking the slot
//! drops and wipes them exactly as on desktop. Nothing here holds a second copy,
//! and nothing may: a cached key beside the slot would survive `lock()` and
//! silently defeat the whole state machine.

use myne_core::hooks::Hooks;
use myne_core::plugins::live::LiveSessionRegistry;
use myne_core::plugins::vault_indices::VaultIndicesState;
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;
use myne_core::search::SearchIndexState;
use std::sync::OnceLock;

static STATE: OnceLock<VaultRuntimeState> = OnceLock::new();
static HOOKS: OnceLock<Hooks> = OnceLock::new();
static INDICES: OnceLock<VaultIndicesState> = OnceLock::new();
static SEARCH: OnceLock<SearchIndexState> = OnceLock::new();
static CREATION: OnceLock<myne_core::plugins::vault_creation::state::VaultCreationState> =
    OnceLock::new();
/// The Worker's live co-editing sessions (epic live-collab,
/// `collab-editor-bridge`). A process-global for the same reason as [`state`]: the
/// wasm entry surface has no `State` handle to thread. `WebHooks` clears it on
/// every vault-leaving hook, which is what the lock-teardown guard keys on.
static LIVE_SESSIONS: OnceLock<LiveSessionRegistry> = OnceLock::new();

/// The Worker's live co-editing sessions. See the static's note.
pub fn live_sessions() -> &'static LiveSessionRegistry {
    LIVE_SESSIONS.get_or_init(LiveSessionRegistry::default)
}

/// The Worker's single [`VaultRuntimeState`].
pub fn state() -> &'static VaultRuntimeState {
    STATE.get_or_init(VaultRuntimeState::default)
}

/// The Worker's single [`VaultCreationState`] (`decisions.md` 2026-08-15).
///
/// A process-global for the same reason as [`state`]: on desktop Tauri manages
/// it and hands each command a `State<'_, VaultCreationState>`, and the wasm
/// entry surface has no equivalent handle to thread through.
///
/// It holds **secret-bearing in-flight sessions** between `begin` and `commit`:
/// the recovery phrase, `root_key`, and both derived wrap keys, each in a
/// `Zeroizing` wrapper that wipes on drop. Two things bound how long they live,
/// and only one of them exists here. The slot cap is enforced on both platforms
/// by the reservation at `begin`. The desktop's **background TTL evictor** is
/// the half that is absent: it is a `tauri::async_runtime` interval task with no
/// counterpart in this crate, so a session dropped by the user closing the tab
/// dies with the wasm instance rather than being swept. That is the same
/// lifetime the rest of this Worker's key material already has, which is why it
/// is acceptable and why it is written down rather than left to be discovered.
pub fn creation() -> &'static myne_core::plugins::vault_creation::state::VaultCreationState {
    CREATION.get_or_init(myne_core::plugins::vault_creation::state::VaultCreationState::default)
}

/// The lifecycle hooks.
///
/// [`crate::hooks::WebHooks`] since task 83 — and the switch mattered more than
/// it looks. Inheriting `NoopHooks` was not a reduced feature set: it silently
/// disabled `bump_local_change`, which is the ONLY thing that increments the
/// counter the sync loop edge-triggers on, so a browser edit never opened a push
/// cycle and sync was ONE-WAY with no error anywhere.
///
/// The old note below is kept because its reasoning about the hooks seam is
/// still right — most members genuinely are desktop-side side effects web does
/// not have. What changed is that "most" is not "all", and each member now
/// carries its own written fate in `hooks.rs` rather than sharing one blanket
/// answer.
///
/// The old note: [`NoopHooks`] was chosen as a **statement about the web client's
/// capability set**, not a stub awaiting completion. Every member of the hooks
/// seam is a desktop-side side effect that web either does not have or has
/// decided against: search-index and spell-engine teardown, the pdf-export
/// render window, clipper pairing hydration, AI vector hydration, screen-capture
/// protection, voice-recording abort. `hooks.rs` documents the settled
/// desktop-only set; task 83 implements `WebHooks` for the members that turn out
/// to have a browser meaning.
///
/// Returning no-ops rather than leaving them unimplemented matters for one
/// specific path: `unlock_from_host` calls the teardown hooks on a **vault
/// switch**, and a switch that silently skipped teardown would leave the
/// previous vault's derived indices live.
///
/// **That argument got weaker with task 14 and is restated rather than left
/// standing.** It used to rest on "there are no indices on web yet"; [`indices`]
/// now exists and holds decrypted wikilink edges, tag names and property keys.
/// The no-op is still correct — but for a different and narrower reason: the web
/// client cannot switch vaults at all yet (`vault_list` is unported and the
/// picker is not built), so the switch branch is unreachable. When task 83
/// implements `WebHooks`, `zeroize_vault_indices` is a member it must actually
/// wire, not inherit as a no-op.
pub fn hooks() -> &'static Hooks {
    HOOKS.get_or_init(|| {
        #[cfg(target_arch = "wasm32")]
        {
            std::sync::Arc::new(crate::hooks::WebHooks) as Hooks
        }
        // The HOST build has no vault, no Worker and no scheduler to signal, so
        // `WebHooks` has nothing to be. It also cannot compile here: its emit
        // goes through `crate::host::WebHost`, which is `wasm32`-gated.
        #[cfg(not(target_arch = "wasm32"))]
        {
            std::sync::Arc::new(myne_core::hooks::NoopHooks) as Hooks
        }
    })
}

/// The wikilink / backlink / tag index (task 14).
///
/// A second process-global for the same reason as [`state`]: Tauri manages it as
/// app state and hands each command a `State<'_, VaultIndicesState>`, and the
/// wasm entry surface has no equivalent handle to thread.
///
/// It holds **decrypted derived data** — wikilink edges, tag names, property
/// keys — so its lifetime matters. Twelve of the fourteen `vault_indices`
/// commands are pure in-RAM queries over it; only `persist` and `hydrate` touch
/// storage. The vault-switch teardown that wipes it on desktop rides
/// `hooks.zeroize_vault_indices()`, which is a no-op here — correct today
/// because the web client cannot switch vaults yet, and a thing task 83 must
/// revisit when `WebHooks` lands rather than inherit silently.
pub fn indices() -> &'static VaultIndicesState {
    INDICES.get_or_init(VaultIndicesState::default)
}

/// The `MYS1` full-text index (tasks 14 + 83).
///
/// Third process-global, same reason as the other two: desktop lets Tauri manage
/// it and hands each command a `State<'_, SearchIndexState>`; the wasm entry
/// surface has no handle to thread.
///
/// It holds **plaintext-derived** data — note titles, tokenised bodies, note ids
/// — so lock must empty it. That is `WebHooks::zeroize_search_index`, which
/// calls `clear()` here; unlike `zeroize_vault_indices`'s note above, this one
/// is wired rather than owed, because an index that outlived the keys would keep
/// every note's terms in RAM after the vault was locked.
///
/// **Body documents only on this client.** The `att:` documents desktop builds
/// come from the `MYE1` extracted-text cache, whose producers do not exist on
/// `wasm32` — so `search_sync_core` is driven here with `NoAttachmentDocs`, and
/// the absence is structural rather than a policy this code could get wrong.
pub fn search() -> &'static SearchIndexState {
    SEARCH.get_or_init(SearchIndexState::default)
}

#[cfg(test)]
mod tests {
    /// The web target installs `WebHooks` and never falls back to `NoopHooks`.
    ///
    /// Task 83's own acceptance criterion, and it is a test rather than a
    /// comment because the fallback it guards against is SILENT: `Hooks` is
    /// `Arc<dyn VaultLifecycleHooks>`, so a build that installed the wrong one
    /// would compile, run, answer every command, and simply never push a local
    /// edit. Asserting on the source is the only check available here — the host
    /// build cannot construct `WebHooks` (its emit is `wasm32`-gated), so a
    /// runtime assertion would have to be `wasm32`-only, which is the lane with
    /// no test runner.
    #[test]
    fn the_web_target_installs_web_hooks() {
        let src = include_str!("session.rs");
        // The wasm arm must construct `WebHooks`...
        assert!(
            src.contains("std::sync::Arc::new(crate::hooks::WebHooks)"),
            "the wasm arm must install WebHooks"
        );
        // ...and `NoopHooks` may appear ONLY under the not-wasm32 arm. Checked by
        // position rather than by absence, because the host arm legitimately
        // uses it.
        let wasm_arm = src
            .split("#[cfg(not(target_arch = \"wasm32\"))]")
            .next()
            .unwrap_or("");
        assert!(
            !wasm_arm.contains("Arc::new(myne_core::hooks::NoopHooks)"),
            "the wasm arm must not fall back to NoopHooks"
        );
    }
}
