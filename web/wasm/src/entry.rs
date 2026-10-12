// SPDX-License-Identifier: AGPL-3.0
//! The exported wasm surface — everything the Worker can call.
//!
//! Three exports and no more. The Worker is the only caller (`web/src/worker/`),
//! and every one of these is reached from there and nowhere else.
//!
//! This module compiles **only** for wasm32 (see `lib.rs`), so there are no
//! host arms here to reason about.
//!
//! # The contract this file holds
//!
//! **Nothing here throws.** Not on a command error, not on malformed arguments,
//! not on an unknown command. The reason is in `outcome.rs`: on `wasm32` a Rust
//! panic aborts, and an aborted instance is permanently unusable, while a
//! command error leaves it perfectly healthy. If both arrived at the Worker as a
//! JS exception the Worker could not tell them apart, and would either discard a
//! good instance or keep calling a dead one.
//!
//! So an exception escaping into the Worker means **exactly one thing**: the
//! instance is gone. `web/src/worker/protocol.ts` maps that to `fatal`; task 82
//! owns the recovery.

use crate::dispatch::dispatch;
use crate::outcome::Outcome;
use wasm_bindgen::prelude::*;

/// Answer one `invoke` from the page.
///
/// `args_json` is the argument payload as JSON — the same JSON the desktop's
/// Tauri IPC would carry, which is what keeps `src/`'s call sites identical
/// across the two clients. `""` means "no arguments".
///
/// Returns the [`Outcome`] envelope as a JSON string. Always. See the module
/// note on why this signature is not `Result<String, JsValue>`.
#[wasm_bindgen]
pub async fn invoke(cmd: String, args_json: String) -> String {
    let args = if args_json.is_empty() {
        serde_json::Value::Null
    } else {
        match serde_json::from_str(&args_json) {
            Ok(v) => v,
            // The payload was not JSON at all. That is a bug in the Worker
            // transport rather than in a call site, but it still must not throw:
            // a `BadArgs` envelope tells the page which command failed and why,
            // and leaves the instance usable.
            Err(e) => {
                return Outcome::BadArgs {
                    command: cmd,
                    // serde_json's Display names the position and the expected
                    // token — never the payload bytes, which may be a note body.
                    detail: e.to_string(),
                }
                .to_json();
            }
        }
    };

    dispatch(&cmd, args).await.to_json()
}

/// Answer one `invoke` that carries a bulk BYTE payload beside its JSON.
///
/// # Why a second entry point instead of putting the bytes in the JSON
///
/// The shared IPC shape for an attachment import is
/// `{ kind: "bytes", bytes: number[] }`, and on desktop that is fine — Tauri
/// serialises it once, and the picker path does not use it at all (Rust opens
/// the path itself). On web the same shape would send a 64 MiB file as a
/// 64-million-element JS array, structured-cloned to the Worker, then
/// `JSON.stringify`d into a ~200 MB string, then parsed by `serde_json` one
/// number at a time. That is not a slow path; it is an out-of-memory path.
///
/// `wasm_bindgen` converts a `Uint8Array` into `Vec<u8>` with a single memcpy,
/// so the bytes arrive here having been copied exactly once — and the page never
/// touches them at all, because the Worker reads the `File` itself
/// (`web/src/worker/worker.ts`).
///
/// # The channel is deliberately narrow
///
/// [`crate::dispatch::dispatch_with_bytes`] answers exactly one command and
/// refuses every other by name. A general "any command may take a byte payload"
/// door would be a second argument path for the whole surface, with its own
/// rules about which argument the bytes replace — the kind of ambiguity that
/// ends in a command reading a payload it was not written for.
#[wasm_bindgen]
pub async fn invoke_with_bytes(cmd: String, args_json: String, bytes: Vec<u8>) -> String {
    let args = if args_json.is_empty() {
        serde_json::Value::Null
    } else {
        match serde_json::from_str(&args_json) {
            Ok(v) => v,
            Err(e) => {
                return Outcome::BadArgs {
                    command: cmd,
                    detail: e.to_string(),
                }
                .to_json();
            }
        }
    };
    crate::dispatch::dispatch_with_bytes(&cmd, args, bytes)
        .await
        .to_json()
}

/// The build's own identity, for the Worker's startup handshake.
///
/// One field today. It is returned as a JSON object rather than a bare string so
/// the handshake can gain a field without changing the export's signature.
///
/// Deliberately **not** carrying a copy of the protocol version or the AAD
/// prefix. Retyping a cryptographically load-bearing constant into a diagnostic
/// export would create a second place it can be wrong, and the actual skew this
/// guards against — glue JS from one build paired with a `.wasm` from another —
/// is already caught by `wasm-bindgen`'s own generated signature checks. This
/// field exists so the *Worker* can name the build in a startup log line, not to
/// re-assert the format.
#[wasm_bindgen]
pub fn build_info() -> String {
    serde_json::json!({ "crate_version": env!("CARGO_PKG_VERSION") }).to_string()
}

/// Prove the CSPRNG is live, before any vault operation depends on it.
///
/// # Why this exists as an export
///
/// `getrandom`'s `custom` hook is resolved at **link** time, so a missing
/// registration fails the build — but a registration that links and then throws
/// at runtime (no secure context, a hostile host object) would otherwise first
/// surface as a failed *write*, after the user typed a password and unlocked a
/// vault. That is the worst possible moment to discover it.
///
/// So the Worker calls this once during startup and refuses to report ready if
/// it fails. `true` means two 32-byte draws succeeded and differed; anything
/// else is `false`. Task 81's browser verification drives the same export for N
/// sequential draws.
///
/// The drawn bytes never leave this function and are never logged.
#[wasm_bindgen]
pub fn csprng_self_check() -> bool {
    let mut a = [0u8; 32];
    let mut b = [0u8; 32];
    if getrandom::getrandom(&mut a).is_err() || getrandom::getrandom(&mut b).is_err() {
        return false;
    }
    // Two independent 32-byte draws colliding has probability 2^-256; if it
    // happens the source is broken, and a stub returning zeros — the realistic
    // failure — is exactly what `a != b` catches.
    a != b
}

/// Install the browser's sync transport (phase3-web-client task 35).
///
/// Separate from module instantiation on purpose: `build_transport` in
/// `myne-core` answers `https` through whatever factory has been installed, and
/// a sync command that ran before this would get `BadRequest` — a startup bug
/// wearing a network error's clothes. Exported so the Worker calls it in the
/// same startup block that installs the JS bridges, where the ordering is
/// visible in one place.
///
/// Idempotent: the factory slot is a `OnceLock`, so a second call is a no-op
/// rather than a race.
/// Install the panic hook (phase3-web-client task 82).
///
/// # Why a hook exists at all under `panic = "abort"`
///
/// `wasm32-unknown-unknown` aborts on panic and the instance is permanently
/// unusable afterwards — every later call traps on `unreachable`. Without a
/// hook, that converts an unlocked session into an infinite spinner with no
/// visible cause: the Worker's `onerror` fires, the page learns *something*
/// died, and nothing says what. The hook runs BEFORE the abort, which is the one
/// moment the location is still knowable.
///
/// # What it captures, and what it refuses to
///
/// **`file:line` only. Never the payload.** A panic message is arbitrary text
/// from arbitrary code: an `expect("failed to decode note {id}")` carries a note
/// id, and an `unwrap` on a parse can carry the bytes that failed to parse — a
/// note body. `src-tauri/AGENTS.md`'s DENY list covers both, and this surface is
/// worse than a log file: the code it reaches is a browser console, readable by
/// devtools, by any extension with devtools access, and by whoever the user
/// screenshots it to.
///
/// The location is not on the DENY list and is what a maintainer can act on. It
/// is a SOURCE path (`core/src/…`), not a filesystem path — the DENY list's
/// concern is the user's directory layout, which a compiled-in `file!()` cannot
/// contain.
///
/// # Why it forwards through a JS shim rather than posting itself
///
/// The hook runs on the Worker thread with the instance already doomed; calling
/// back into wasm would be calling into a module that is about to be
/// unreachable. A plain imported JS function is the only thing guaranteed to
/// still work, and the Worker's own message plumbing takes it from there.
#[wasm_bindgen]
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        // `location()` is `Option` only in theory here — a panic raised by
        // `panic!`/`unwrap`/`expect` always carries one. `unknown` rather than a
        // second panic, because a panicking panic hook aborts with no report at
        // all.
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".to_string());
        // Deliberately NOT `info.payload()` / `info.to_string()`. See above.
        report_wasm_panic(&location);
    }));
}

#[wasm_bindgen]
extern "C" {
    /// Implemented by `web/src/worker/worker.ts`: posts one `fatal` envelope to
    /// the main thread. Imported rather than called through the module's own
    /// exports because by the time this runs the instance is doomed.
    #[wasm_bindgen(js_name = "reportWasmPanic")]
    fn report_wasm_panic(location: &str);
}

#[wasm_bindgen]
pub fn install_sync_transport() {
    crate::sync_transport::install();
}

/// One sync-scheduler tick: decide, maybe run a cycle, feed the outcome back.
///
/// The JS boundary for [`crate::sync_loop`], here rather than beside its logic
/// because this file IS the boundary — `tests/web/wasm-boundary.test.ts` asserts
/// the hand-written `.d.ts` matches exactly the exports `entry.rs` declares, and
/// a `#[wasm_bindgen]` scattered into another module is the drift that test
/// exists to catch. Same split `install_sync_transport` already uses.
///
/// Returns the action taken (`"idle"`, `"pull"`, `"push"`, `"pull-and-push"`) so
/// the loop is observable from a browser test without exporting the scheduler's
/// internals.
#[wasm_bindgen]
pub async fn sync_tick() -> String {
    crate::sync_loop::tick().await
}

/// Tell the scheduler something happened: `"local-change"`, `"focus"`, `"poke"`.
///
/// An unknown name is IGNORED rather than trapping — `panic = "abort"` makes
/// every panic terminal for the Worker, so a page that learns a new signal
/// before the wasm does must degrade to not-firing-it, not to a dead vault.
#[wasm_bindgen]
pub fn sync_signal(kind: &str) {
    crate::sync_loop::signal(kind);
}

/// `{"endpoint","token"}` JSON for the poke stream, or `None` when sync is not
/// usable yet (no endpoint configured, or this device is not enrolled).
///
/// The awareness reader shares this export rather than adding a second target
/// lookup (task 4, acceptance criterion 4): the token already crosses into JS on
/// every sync request, so a second copy would add exposure and a second place to
/// keep in step with none.
#[wasm_bindgen]
pub async fn sync_poke_target() -> Option<String> {
    crate::sync_loop::poke_target().await
}

/// Deliver one opaque awareness frame the Worker read off `/sync/awareness`.
///
/// `payload` is the SSE `data:` payload verbatim, with the prefix stripped by
/// the reader; this side stores it opaque and never parses it (`crate::awareness`
/// is the transport's read-side seam, user story 8). The up-path POST is driven
/// from `sync_tick`, so there is no matching "send" export: the editor bridge,
/// which WILL produce frames, is Rust inside this same wasm instance and calls
/// `crate::awareness::push_outgoing` directly rather than crossing back to JS.
#[wasm_bindgen]
pub fn sync_awareness_deliver(payload: String) {
    crate::awareness::deliver(payload.into_bytes());
}
