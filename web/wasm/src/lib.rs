// SPDX-License-Identifier: AGPL-3.0
//! `myne-web-wasm` — the web client's wasm entry surface.
//!
//! # What this crate is
//!
//! The web client has no Tauri IPC layer, so something has to be the thing that
//! receives `(cmd, args)` and calls into `myne-core`. On desktop that is
//! `src-tauri`'s `generate_handler!`. Here it is [`dispatch`], compiled to wasm
//! and instantiated inside **one dedicated Worker**.
//!
//! # Why a Worker, and why *one*
//!
//! Not a preference and not an optimisation. `createSyncAccessHandle` — the only
//! OPFS write API available in every browser we ship to, since Safari implements
//! no `createWritable` — is **dedicated-worker-only**. So the storage layer
//! cannot run on the main thread, and since the wasm module is what performs
//! every decrypt and encrypt, it has to live where the storage does. One Worker
//! rather than several because the keys live in it: a second instance would mean
//! a second copy of `root_key` and a second `FileSystemSyncAccessHandle` on the
//! same files, which OPFS refuses with `NoModificationAllowedError` anyway.
//!
//! The useful side effect is that the ~0.5 s Argon2id derivation never occupies
//! the main thread, so the unlock screen stays responsive while it runs.
//!
//! # Module layout
//!
//! | Module | Target | Role |
//! |---|---|---|
//! | [`capability`] | all | which commands are answered, refused, or still owed |
//! | [`outcome`] | all | the tagged envelope that crosses the boundary |
//! | [`dispatch`] | all | the router |
//! | `entry` | wasm32 | the `#[wasm_bindgen]` exports |
//! | `csprng` | wasm32 | `getrandom`'s `custom` backend → `crypto.getRandomValues` |
//!
//! The first three are **not** gated on wasm32, and that is deliberate: they
//! carry the classification logic and the failure-shape decisions, which are the
//! parts most likely to be wrong, and gating them would put them beyond
//! `cargo test --workspace`. See `Cargo.toml` for the full reasoning.

/// Object URLs for decrypted attachments (task 44).
///
/// Host-compiled despite being JS glue, because its caller is a ROUTER ARM and
/// `dispatch.rs` keeps arms un-gated on principle: the agreement test runs
/// natively, so a wasm-only arm is a routing decision no gate in `pre-push` can
/// see. The two JS calls have host stubs that the serve path never reaches.
pub mod attachment_url;
pub mod capability;
pub mod dispatch;
/// The browser's Argon2id memory ceiling (task 31) — a policy number, so
/// host-compiled and unit-tested rather than gated with the JS glue that reads
/// it.
pub mod kdf_ceiling;
pub mod outcome;
/// The person credential, held in the Worker's memory (myne-md/myne#911 task 13).
/// Deliberately NOT `wasm32`-gated: it is a `VaultIo` decorator with no JS in it,
/// so `cargo test -p myne-web-wasm` exercises its rules on the host.
pub mod person_io;

// ── wasm32-only ──────────────────────────────────────────────────────────────
//
// `entry` needs `wasm-bindgen` and `csprng` replaces the process entropy source;
// neither has a host meaning. `csprng` in particular must never compile
// natively — `register_custom_getrandom!` would displace the real OS source.

#[cfg(target_arch = "wasm32")]
mod csprng;
#[cfg(target_arch = "wasm32")]
mod entry;
/// [`myne_core::host::HostCtx`] for the browser (task 17) — the web counterpart
/// of core's `TauriHost`, here for the same reason [`opfs`] is: core gains no JS
/// glue.
#[cfg(target_arch = "wasm32")]
pub mod host;

/// The browser's [`myne_core::hooks::VaultLifecycleHooks`] (task 83).
///
/// `wasm32`-gated with the other JS-boundary modules: it emits through
/// `crate::host::WebHost` and signals `crate::sync_loop`, both of which are.
/// The host build keeps `NoopHooks`, which is correct there — that build exists
/// to type-check and to run the router's tests, and installs no vault.
#[cfg(target_arch = "wasm32")]
pub mod hooks;
/// [`myne_core::vault_io::VaultIo`] over OPFS (task 17).
///
/// Lives here rather than in `myne-core`'s wasm arm so that core gains no
/// `web-sys` and no `wasm-bindgen`-for-IO — it keeps exactly the dependency
/// graph desktop and mobile already compile. This crate is the JS-boundary
/// crate; that is what it is for.
#[cfg(target_arch = "wasm32")]
pub mod opfs;

/// [`myne_core::plugins::sync::transport::SyncTransport`] over the browser's
/// HTTP stack (task 35) — synchronous XHR, which a dedicated Worker is allowed
/// to make, so the blocking trait ports unchanged.
#[cfg(target_arch = "wasm32")]
pub mod sync_transport;

/// The sync origin string (tasks 35 + 84) — pure arithmetic, so host-compiled
/// and unit-tested rather than gated with the JS glue that uses it.
pub mod sync_origin;

/// The Worker's live-awareness state (live-collab, collab-client-transport task
/// 4): the received-frame inbox and the outgoing coalescer/POST bound to the
/// SHARED ~100 ms machine (`awareness_coalesce`). Host-compiled, like
/// `sync_origin` and `capability`, so `cargo test -p myne-web-wasm` covers the
/// coalescing and POST classification with no browser. The JS reader that feeds
/// the inbox is `web/src/worker/sync-loop.ts`.
pub mod awareness;

/// The browser's sync tick driver — the glue half of `loop_control`, never its
/// decisions. See the module doc for what differs from the desktop loop and what
/// deliberately does not (phase3-web-client task 84).
///
/// Only its two `#[wasm_bindgen]` wrappers are `wasm32`-gated, not the module:
/// the router's enrolment arm calls into it, and that arm is deliberately not
/// gated either (`dispatched_names_match_the_router` runs on the host). The
/// SCHEDULER it drives is shared with desktop and covered by
/// `cargo test --workspace` in `myne-core`.
pub mod sync_loop;

/// The Worker's session state — one [`myne_core::plugins::vault_unlock::state::VaultRuntimeState`]
/// holding the unlocked vault's keys (task 12).
pub mod session;

/// The cross-language constants the OPFS bridge depends on.
///
/// Host-compiled on every target so `cargo test --workspace` covers it: the
/// numeric failure-kind mapping is duplicated in Rust and TypeScript by
/// necessity (it crosses the wasm boundary on every failing call), and a comment
/// saying "keep these in sync" is not a mechanism.
pub mod opfs_contract;

/// The shared `block_on` the host-build test modules drive their futures with.
/// Test-only: it is a no-op executor, not a runtime this crate ships.
#[cfg(test)]
mod test_support;
