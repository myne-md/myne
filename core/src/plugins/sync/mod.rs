// SPDX-License-Identifier: AGPL-3.0
//! `sync` Tauri plugin (MYND-424, the Phase 2 client sync engine namespace).
//!
//! This is the shared plugin namespace that MYND-424 (engine) + MYND-425
//! (device-mgmt) + MYND-426 (deletion/cache) + MYND-427 (fork-conflict) all add
//! commands to — one plugin, one capability entry, deny-by-default (SYNC-15).
//!
//! ## Task-3 surface (this landing)
//!
//! - [`config`] — the device-local **endpoint-config** surface (SYNC-14): the
//!   real self-host operator setting (TB5), reused by the MYND-428 E2E harness.
//!   Exposed as `sync_get_endpoint` / `sync_set_endpoint`.
//! - [`transport`] — the blind-relay [`transport::SyncTransport`] seam (SYNC-3).
//!   The real impl is [`rustls_transport`]: rustls verifying the certificate
//!   chain and server name against bundled public roots, plus the keying-material
//!   exporter (R3-gated; see `docs/dependency-policy.md`). The engine builds
//!   against the trait, and [`transport::FakeTransport`] backs unit tests.
//!
//! ## Capability ACL (deny-by-default, SYNC-15)
//!
//! `sync:default` bundles ONLY `allow-sync-get-endpoint` +
//! `allow-sync-set-endpoint`, main-window-only. No data-plane command exists
//! yet; the push/pull/sync-now/status commands (later tasks) are added to the
//! same plugin and gated on an authenticated session.

// The transport trait + types are consumed by the pull/push paths (tasks 5/6);
// `FakeTransport` is exercised by this module's unit tests now. Until the engine
// lands, the production-side trait surface is otherwise unreferenced — same
// "consumed later" justification the `themes` module uses.
#![allow(dead_code)]

// ── the Tauri-shaped third of the sync plugin (phase3-web-client task 79) ────
//
// Three of this plugin's 22 modules are typed on the host: `commands` (the
// `#[tauri::command]` layer plus the `AppHandle`-driven cycle runner),
// `loop_control` and `poke_listener` (which drive it). Everything else — the
// engine, reconcile, merge, the version-vector logic, `transport`'s trait, the
// wire codec, `token_store`, `state` — is target-independent and stays
// compiled, which is the point: the browser client reuses the *engine* and
// brings its own transport (`fetch` + `EventSource`, task 84), rather than
// porting an `AppHandle`-shaped command layer that has no browser meaning.
//
// This is where task 79 stops for `sync`. Giving these three host arms is a
// larger piece of work than the other 17 plugins combined — 10 of the crate's
// 11 emit sites, the only `app_config_dir` consumer, and six
// `Manager::try_state` singletons whose `None` case is a silent no-op — and it
// belongs with task 84, which is what will define what the browser side of each
// actually does.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
pub mod commands;
// Ungated: the authority resolver reads a vault through `VaultIo` and `protocol` only, and
// its consumers (`roster_trust`, `cycle`, `device_binding::store`) are compiled on every
// target. Gating it would break the wasm core, which resolves `myne-core` with
// `default-features = false`.
pub mod authority;
pub mod config;
// "Does this device hold the whole vault?" (phase3-web-client task 89) — the
// gate on whole-corpus destructive sweeps, whose signal is the vault head's own
// `manifest_hash` rather than any approximation of it.
pub mod conflict;
pub mod corpus;
pub mod crdt_doc;
/// This device's 16-byte id, read in exactly one place (myne-md/myne#958). The
/// ONLY module that may read `sync-state.json`'s or `person-auth.json`'s
/// `device_id_hex`; `scripts/check-device-actor.mjs` holds that, because two
/// readers of "which device is this" had already diverged twice.
pub mod device_actor;
pub mod device_identity;
// The two-sided device admission ceremony (`decisions/protocol/0762`).
//
// NATIVE-ONLY, and it must stay that way: it borrows
// `plugins::device_binding::commands`, which is itself
// `#[cfg(not(target_arch = "wasm32"))]` because the person account plane it reads
// has no browser meaning. Left ungated, `cargo clippy --target wasm32-unknown-unknown`
// fails with `cannot find \`commands\` in \`device_binding\`` and the web bundle
// never builds (myne-md/myne#938 review).
#[cfg(not(target_arch = "wasm32"))]
pub mod device_admission;
// Rung 3 of the device-key storage ladder (`decisions/protocol/0733` decision 4):
// a `0600` file sealed by a user PIN, for the platforms whose OS store the build
// does not reach. Kept beside `device_identity` because it is the same key's second
// resting place, not a second identity. The CODEC ships here; the ceremony that
// asks for a PIN and calls it does not (see `device_identity`'s header).
pub mod device_key_pin;
pub mod devices;
/// The typed `vault.dictionary` inner payload (`0x02`) and its §10.2.1 merge
/// (myne-md/myne#640).
pub mod dictionary_payload;
// One orchestrated sync cycle + its side effects, lifted out of the host-gated
// `commands` module by task 84. See the module doc for what was host-shaped and
// how each piece became a seam call — in particular why driving the cycle needed
// a NEW seam function (`task::run_blocking_future`) rather than either of the
// two that already existed.
pub mod cycle;
// One verdict over the five facts that decide whether this device can sync
// (myne-md/myne#1003). A READER that consumes `cycle`'s authority builder rather than
// resolving a second time. See its module doc for why every fact is projected from
// one decision.
pub mod doctor;
pub mod engine;
pub mod enroll;
pub mod fork_audit;
pub mod head_authority;
pub mod http_transport;
pub mod identity_resolver;
pub mod integrity;
pub mod invite;
pub mod member_removal;
// "What kind of `vault.meta` is this", answered once for the whole plane: the six
// raw magic comparisons it replaced each predated `NTV8` and each failed differently
// (no head context, an `0x01` downgrade, the wrong account token, a re-offered publish,
// a refused second-device join).
pub mod meta_kind;
// The owner-side durable outbox for rotation-package delivery (myne-md/myne#797):
// the rotation writes the sealed packages here before it touches the network, and
// every sync cycle / unlock drains it until each recipient's POST has succeeded.
// Host-only for the same reason `person_account` is: it drives the rustls
// transport.
pub mod roster_trust;
#[cfg(not(target_arch = "wasm32"))]
pub mod rotation_outbox;
// Ungated as of phase3-web-client task 84 — but only half of it compiles for a
// browser. `loop_control`'s decision state machine (`SyncScheduler`, the retry
// ladder, the constants) is pure and target-independent; its runtime glue
// (`spawn_sync_loop`, the three `Manager::try_state` signal cells) is gated
// per-item inside the file. The reason for the asymmetry is written there: the
// cadence, focus rate-limiting, push coalescing and extend-only backoff are the
// privacy-load-bearing answers, and a second client re-deriving them is how two
// clients end up disclosing at two different granularities.
pub mod awareness_coalesce;
pub mod loop_control;
// The no-bypass ratchet (MYND-650 task 4): a source-level guard asserting that
// every outbound socket in this directory is either routed through the proxy
// gate or written down with the reason it cannot leak a source IP. Test-only —
// it ships nothing, it just refuses to let a second socket appear unnoticed.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
pub mod awareness_listener;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod no_bypass;
pub mod orchestrator;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
pub mod poke_listener;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
pub mod stream_supervisor;
// How far through materialising a vault this device is (phase3-web-client task
// 39). Three atomics rather than an event per note or a host threaded through
// `run_sync_cycle`: the readout has to be observable DURING the loop, and the
// loop deliberately has no host.
// UNGATED with `person_account` below (myne-md/myne#911 task 13), and for the
// same reason: none of the three touches a keychain or a raw socket. Each is a
// sealed file through the `VaultIo` seam, so a browser can carry the module; what
// a browser does not carry is the MEMBER surface that calls two of them, and that
// refusal lives in the capability table rather than in a cfg.
pub mod member_unlock_store;
pub mod person_vault_carrier;
// The person account, membership and invite plane. UNGATED as of myne-md/myne#911
// task 13, and the reason the gate came off is the same one `loop_control`'s
// comment states: the `SyncTransport` trait is the seam, so gating belongs at the
// raw-TLS implementation (`rustls_transport`, still gated) and not at every
// caller. What the old comment named as the blocker had already been handled
// underneath it: every `TauriHost` reference in this module is inside a
// `#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]` command
// wrapper, and the network calls go through `super::transport` rather than
// through `rustls_transport` directly. The web client's own transport
// (`web/wasm/src/sync_transport.rs`) is what fills the seam there.
pub mod person_account;
pub mod person_ai_store;
#[cfg(not(target_arch = "wasm32"))]
pub mod person_ai_sync;
pub mod person_auth;
pub mod person_discovery;
pub mod prefs_classification;
pub mod prefs_merge;
pub mod progress;
pub mod publish;
// Where the transport is allowed to send bytes when device-local Tor routing is
// on (MYND-650). Shared rather than desktop-only even though only the desktop
// host can spawn the arti sidecar: the *decision* — and specifically the
// fail-closed refusal to ever connect directly while Tor mode is on — belongs
// next to the transport that has to honour it, not next to the process
// supervisor that feeds it.
pub mod proxy;
pub mod qr_join;
pub mod reconcile;
pub mod reconcile_policy;
pub mod roster;
// Raw-TLS transport, host-only. `rustls 0.23` with the `ring` provider has no
// wasm32 backend, and a browser has no raw TCP socket to put TLS on regardless
// — its transport is `fetch` + `EventSource` (phase3-web-client task 84). The
// `SyncTransport` trait in `transport` is already the seam, so gating stops at
// this one implementation: the trait, the engine and every caller stay
// target-independent.
#[cfg(not(target_arch = "wasm32"))]
pub mod rustls_transport;
#[cfg(test)]
mod sim;
// The SOCKS5 client half of Tor routing (MYND-650 task 3) — host-only for the
// same reason `rustls_transport` is: it is raw TCP, which a browser tab does
// not have. A web client that wants Tor uses Tor Browser (task 12), not an
// in-page tunnel.
#[cfg(not(target_arch = "wasm32"))]
pub mod socks5;
pub mod state;
// The status indicator's types + derivation, lifted out of the host-gated
// `commands` module by task 84 so the browser reports the same states from the
// same code. Only the `Manager`-shaped live-status CELL stayed behind.
pub mod status;
// The device-local record of which beta terms this device accepted
// (myne-ops#15). It sits in the sync plugin because sync is what it gates —
// the terms govern the hosted service, and nothing else in the app needs
// agreeing to. Shared rather than desktop-only for the same reason
// `tor_config` is: the *rule* (a version, not a boolean; every failure re-asks)
// belongs beside the flow that honours it, and mobile owes the same gate.
pub mod legal_consent;
pub mod token_store;
// The device-local `tor_routing_enabled` preference (MYND-650 task 6) — the one
// writer of `proxy::ProxyGate`'s enabled flag. Shared rather than desktop-only
// for the same reason `proxy` is: the *rule* (what the file means, and which way
// a corrupt one fails) belongs beside the transport that honours it, while only
// the desktop host can act on it by spawning a sidecar.
pub mod tor_config;
pub mod transport;
// Per-NOTE "not yet on the server" (phase3-web-client task 23). A sibling of
// `status` rather than a field on it: `status` is a property of the device and
// this is a property of each note, and the two diverge in exactly the case that
// matters — an `Idle` device holding edits the server has never seen.
pub mod unsynced;
// The SYNC-40 eye-compare's push hold (myne#462). Ungated on purpose: the
// browser runs this ceremony on both sides, so the flag cannot live in Tauri
// managed state the way `loop_control`'s mobile lifecycle signal does.
pub mod verify_hold;

/// Byte slice → lowercase hex, in a single allocation (no per-byte `format!`).
/// The canonical hex encoder for the sync module — the per-file `hex` /
/// `hex_encode` / `hex_lower` helpers alias this so the logic lives in one place.
pub(crate) fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).expect("high nibble < 16"));
        s.push(char::from_digit((b & 0x0f) as u32, 16).expect("low nibble < 16"));
    }
    s
}
// NOTE: `init()` + `generate_handler!` + the `sync:default` capability live in
// each CLIENT's thin shim (desktop `src-tauri/src/plugins/sync/mod.rs`, mobile
// `mobile/src-tauri/src/plugins/sync/mod.rs`), not here — the same
// per-client-wiring split the `notes`/`prefs` cores use. The command bodies +
// engine + transport all live in this shared core (decisions.md 2026-07-07,
// supersedes the 2026-06-30 "sync stays per-client" scope).

/// Whether this run was told to exercise **real** fixtures, so a missing one is
/// a failure rather than a skip.
///
/// The server-backed tests in `orchestrator.rs` and `sim.rs` all self-skip when
/// the companion `myne-server` binary is not built — and a Rust test that
/// returns early **passes**, so 27 of them reported `ok` on every machine and
/// every CI run that lacked it. That is indistinguishable, in the summary line
/// and in the exit code, from having actually run.
///
/// `MYNE_TEST_REQUIRE_FIXTURES=1` is the umbrella every resource honours, so CI
/// sets one variable and cannot half-cover the set. `specific` is the narrow
/// knob for a developer who has provisioned only one of them
/// (`MYNE_TEST_REQUIRE_SERVER` here; `MYNE_TEST_REQUIRE_MODELS` and
/// `MYNE_TEST_REQUIRE_DICTS` are the desktop crate's equivalents, which carry
/// their own copy of this predicate because a `#[cfg(test)]` item does not
/// cross a crate boundary).
///
/// Opt-in rather than default, deliberately: a contributor who has not built
/// the companion server should still get "skipped". The defect being fixed is
/// *"reports green while asserting nothing"*, not *"requires a server"*.
#[cfg(test)]
pub(crate) mod test_fixtures {
    pub(crate) fn required(specific: &str) -> bool {
        std::env::var(specific).is_ok() || std::env::var("MYNE_TEST_REQUIRE_FIXTURES").is_ok()
    }
}
