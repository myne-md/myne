//! `sync` plugin — mobile shim over the shared [`myne_core::plugins::sync`] core.
//!
//! The Phase-2 client sync engine (MYND-424–427) — commands, engine,
//! orchestrator, transport, conflict/reconcile, device enrollment — lives in the
//! shared `myne-core` crate (extracted from the desktop crate, decisions.md
//! 2026-07-07). This mobile crate keeps only the per-client wiring: [`init()`] +
//! `generate_handler!` + the `sync:default` capability entry
//! (`capabilities/default.json`). Same split the `notes`/`prefs`/`quick_unlock`
//! shims use — the command *bodies* are the identical compiled code the desktop
//! runs, so the mobile client has no second sync implementation to audit.
//!
//! ## Capability ACL (deny-by-default, SYNC-15)
//!
//! `sync:default` bundles all thirty-four commands into ONE narrow,
//! main-window-only grant — the nineteen-command desktop `sync:default` surface
//! (including the recovered-notes quarantine quartet
//! `sync_list_quarantine`/`sync_read_quarantine`/`sync_restore_quarantine`/
//! `sync_delete_quarantine`, registered here for parity even though no mobile
//! UI surfaces it yet) plus the mobile-only lifecycle pair
//! (`sync_lifecycle_suspend`/`sync_lifecycle_resume`, which flip an in-RAM
//! scheduler flag and move no vault bytes; desktop does not register them
//! because it never manages the `SyncLifecycleSignal`). The device-local
//! endpoint-config pair (`sync_get_endpoint`/`sync_set_endpoint`) is intentionally
//! reachable pre-auth (an operator configures the server before unlocking); the
//! push/pull/status/device commands are gated on an authenticated session inside
//! the shared core. The `build.rs` `InlinedPlugin` command list, the
//! `permissions/sync/default.toml` `commands.allow` entries, and the
//! `generate_handler!` list below MUST match exactly (all thirty-four), a
//! mismatch makes Tauri **fail closed** (the ACL resolver denies the invoke).
//!
//! ## R3 transport review-debt (registration ≠ verified crypto)
//!
//! Registering this plugin exposes enroll/push/pull over the sync transport,
//! whose CA-chain + server-name verifier and the empty-channel-binding SCRAM
//! handshake are **not yet primitive-level reviewed** (grill R3, carried in the
//! epic sync-ledger). Exposing the surface on mobile does NOT discharge that
//! debt — no "-PLUS" / "verified cert-trust" claim may be made until R3 lands.
//!
//! What the endpoint UX may and may not say is decided by
//! `design-notes/sync/0620`: the client verifies against bundled Mozilla
//! public roots, so the honest phrasing is "the certificate chain and server
//! name were checked" and NOT "verified" (the R3 clause above), and there is no
//! pin to describe at all. The copy lives in `locales/en/common.json` under
//! `sync.endpoint.*`; `src/components/sync/EndpointConfig.tsx` is the desktop
//! twin and both read the same keys.
//!
//! See the main repo's `src-tauri/AGENTS.md` "Secret-handling logging discipline"
//! for the DENY-list this wrapper (and the shared core) follow — no token /
//! password / phrase / root_key / items_key bytes in any `tracing`/log/serialize.

// Re-export the whole core sync surface so existing paths
// (`crate::plugins::sync::loop_control::SyncLocalChange`,
// `crate::plugins::sync::commands`, …) keep resolving unchanged in
// `hooks.rs`/`lib.rs` and the generated command handlers — the desktop shim's
// re-export pattern, mirrored here.
pub use myne_core::plugins::sync::*;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the mobile `sync` plugin — registers the client command surface
/// over the shared-core command bodies. All thirty-four commands, matching the
/// `build.rs` `InlinedPlugin` + `permissions/sync/default.toml` lists exactly.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("sync")
        .invoke_handler(tauri::generate_handler![
            commands::sync_get_endpoint,
            commands::sync_set_endpoint,
            commands::sync_status,
            commands::sync_now,
            commands::sync_person_unlock,
            person_account::sync_person_setup,
            person_account::sync_person_status,
            person_account::sync_person_list_invites,
            person_account::sync_list_vault_invites,
            person_account::sync_person_accept_invite,
            person_account::sync_member_join_vault,
            person_account::sync_person_unlock_member_vault,
            person_account::sync_member_vault_status,
            person_account::sync_person_set_member_password,
            person_account::sync_person_unlock_member_vault_with_password,
            person_account::sync_person_set_member_pin,
            person_account::sync_person_set_member_biometric,
            person_account::sync_person_unlock_member_vault_with_pin,
            person_account::sync_person_unlock_member_vault_with_biometric,
            person_account::sync_member_unlock_status,
            person_account::sync_person_clear_member_unlock,
            person_account::sync_person_profile_write,
            person_account::sync_person_profile_read,
            commands::sync_person_lock,
            commands::sync_person_create_invite,
            commands::sync_list_roster,
            commands::sync_remove_member,
            commands::sync_list_devices,
            commands::sync_account_status,
            commands::sync_approve_device,
            commands::sync_remove_device,
            commands::sync_pending_conflicts,
            commands::sync_take_conflict,
            commands::sync_resolve_conflict,
            commands::sync_mark_tombstone,
            commands::sync_enroll,
            commands::sync_join_account,
            commands::sync_reset_local,
            commands::sync_head_fingerprint,
            commands::sync_verify_hold_begin,
            commands::sync_verify_hold_end,
            commands::sync_list_quarantine,
            commands::sync_read_quarantine,
            commands::sync_restore_quarantine,
            commands::sync_delete_quarantine,
            commands::sync_lifecycle_suspend,
            commands::sync_lifecycle_resume,
            commands::sync_decode_join_qr,
        ])
        .build()
}
