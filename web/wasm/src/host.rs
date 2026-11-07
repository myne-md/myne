// SPDX-License-Identifier: AGPL-3.0
//! [`HostCtx`] for the browser (phase3-web-client task 17).
//!
//! The web counterpart of `myne-core`'s `TauriHost`. Like [`crate::opfs`], it
//! lives in the entry crate rather than in core's wasm arm so that `myne-core`
//! gains no JS glue.
//!
//! Three of the four methods are trivial; the clock is the one worth reading.

use myne_core::host::{EventPayload, HostCtx, HostPathError};
use std::path::PathBuf;
use wasm_bindgen::JsCast;

/// The OPFS root that stands in for `<app_data_dir>`.
///
/// OPFS has **no path API** — it is a tree of handles — so this string is not a
/// filesystem path. It is the prefix `myne_core::paths` builds vault paths from,
/// which `web/src/worker/opfs.ts` then splits on `/` to walk the handle tree.
/// A single leading segment rather than a bare `/` so the container has a name
/// if anything ever inspects it (devtools' storage pane shows the tree).
const APP_DATA_ROOT: &str = "/myne";

/// `<app_config_dir>` — a **sibling**, never derived from the data root.
///
/// `core-hostctx-design.md` makes the point that these are independent on every
/// platform (on macOS, `~/Library/Application Support` vs `~/Library/Preferences`),
/// and `TestHost` has a test asserting one is not derivable from the other. The
/// browser could get away with collapsing them — there is one origin-private
/// store either way — but doing so would encode a "web is special" assumption
/// into a seam whose whole value is that callers cannot tell which host they are
/// on.
const APP_CONFIG_ROOT: &str = "/myne-config";

/// The largest Argon2id memory cost this client will attempt (task 31).
///
/// Declared in [`crate::kdf_ceiling`], not here: it is a policy number rather
/// than JS glue, and this module is `wasm32`-gated, so a constant living here
/// would sit outside `cargo nextest run --workspace`. Its rationale and the three
/// assertions that pin it to the protocol's own bounds are in that module.
use crate::kdf_ceiling::MAX_KDF_MEMORY_KIB;

/// [`HostCtx`] for the vault Worker.
#[derive(Debug, Default, Clone, Copy)]
pub struct WebHost;

impl HostCtx for WebHost {
    fn app_data_dir(&self) -> Result<PathBuf, HostPathError> {
        Ok(PathBuf::from(APP_DATA_ROOT))
    }

    fn app_config_dir(&self) -> Result<PathBuf, HostPathError> {
        Ok(PathBuf::from(APP_CONFIG_ROOT))
    }

    fn sole_vault_id(&self) -> Option<myne_core::vault_id::VaultId> {
        // One origin, one vault, one fixed id — the property `vault_list`'s
        // dispatch arm already relies on when it resolves against this same
        // constant. Answering it here is what lets every OTHER vault-root read
        // work before unlock, where `active_vault_id()` is `None` and the core's
        // `None` arm would otherwise fall to a `std::fs::read_dir` scan that
        // cannot run on `wasm32` (see `HostCtx::sole_vault_id`).
        //
        // Naming the same constant in both places rather than threading it
        // through each call site is deliberate: a second opinion about which
        // directory is the vault is exactly the bug this closes.
        Some(myne_core::paths::web_single_vault_id())
    }

    fn emit(&self, event: &'static str, payload: EventPayload) {
        // Backend→UI push. Posted straight out of the Worker on the same
        // channel as command replies, correlated to no request (`id: 0`), which
        // is the shape `web/src/worker/protocol.ts` defines and `host.ts`
        // demultiplexes.
        //
        // A failure to post is swallowed, deliberately. These are notifications
        // — "sync pulled 3 records", "a snapshot write failed" — and the page
        // re-reads state on its own. Turning a dropped notification into a
        // command failure would convert a cosmetic miss into a broken operation,
        // which is the wrong trade in the direction that matters.
        let _ = post_event(event, &payload);
    }

    fn now_unix_millis(&self) -> u64 {
        // **Not `SystemTime::now()`.** On `wasm32-unknown-unknown` it compiles
        // and then **panics** — verified in std's own source at the pinned
        // toolchain (`library/std/src/sys/time/mod.rs` falls to the `_` arm →
        // `unsupported.rs`, whose `now()` is `panic!("time not implemented on
        // this platform")`). Not "returns the epoch": it aborts the instance,
        // which on `panic = "abort"` wasm is unrecoverable.
        //
        // This is exactly the class of failure the `HostCtx` clock method exists
        // for (`core-hostctx-design.md`: the clock joined the seam after the
        // inventory found `SystemTime::now()` among the things that compile and
        // then fail on wasm).
        //
        // The values this feeds are user-meaningful timestamps *inside* the
        // encrypted blob (a theme's `updated_at`, an attachment's `created_at`)
        // and the wall clocks the sync merge reconciles on. `sync-protocol.md`
        // §11.4 is explicit that these are client wall-clocks from different
        // devices and that skew can make the "wrong" side win — deterministic
        // convergence is the contract, not clock truth. So `Date.now()` is
        // exactly as authoritative here as the OS clock is on desktop.
        //
        // `Date.now()` is ALREADY milliseconds, which is the seam's primitive —
        // so no scaling, and the millisecond resolution the prefs LWW field
        // clocks depend on survives intact. `now_unix_secs()` derives from this.
        js_sys::Date::now() as u64
    }

    fn max_kdf_memory_kib(&self) -> Option<u32> {
        Some(MAX_KDF_MEMORY_KIB)
    }

    fn monotonic_millis(&self) -> u64 {
        // `performance.now()` — the browser's monotonic clock, in milliseconds
        // from an origin the platform chooses (page load, or worker start).
        // Exactly the contract: unspecified origin, only differences meaningful.
        //
        // NOT `Date.now()`. This value backs elapsed-time measurements — an
        // unlock's duration, the recovery-session TTL, the Phase 2+ auto-lock
        // idle timer — and `Date.now()` steps backwards on an NTP correction or
        // a user changing the system clock. A backwards step would extend a
        // recovery session indefinitely, which is precisely what the TTL exists
        // to prevent.
        //
        // `performance` is available on both `Window` and `WorkerGlobalScope`,
        // so this is correct in the Worker where it actually runs.
        js_sys::Reflect::get(&js_sys::global(), &"performance".into())
            .ok()
            .and_then(|p| js_sys::Reflect::get(&p, &"now".into()).ok())
            .and_then(|f| f.dyn_into::<js_sys::Function>().ok())
            .and_then(|f| f.call0(&js_sys::global()).ok())
            .and_then(|v| v.as_f64())
            // A host with no `performance` is not one this client can measure
            // elapsed time on. 0 is the same answer `NoopHost` gives, and it
            // degrades to "no time has passed" — which makes a TTL never fire
            // rather than fire early, the safe direction for a guard whose job
            // is to drop key material.
            .map(|ms| ms as u64)
            .unwrap_or(0)
    }
}

/// Post one backend event to the page.
///
/// Split out so [`WebHost::emit`] stays a statement of intent and the JS-shaped
/// part is isolated. Returns `Err` if the value could not be constructed or
/// posted; the caller discards it.
fn post_event(event: &str, payload: &EventPayload) -> Result<(), wasm_bindgen::JsValue> {
    use wasm_bindgen::JsValue;

    let message = js_sys::Object::new();
    js_sys::Reflect::set(&message, &"id".into(), &JsValue::from(0))?;
    js_sys::Reflect::set(&message, &"kind".into(), &"event".into())?;
    js_sys::Reflect::set(&message, &"event".into(), &event.into())?;

    // Serialized through `serde_json` and re-parsed rather than hand-built
    // field by field: `EventPayload` is a closed enum with a `serde` shape the
    // desktop already emits, and reproducing that shape by hand here would be a
    // second definition of the wire format to keep in step.
    let json = serde_json::to_string(payload).map_err(|_| JsValue::from_str("payload"))?;
    let value = js_sys::JSON::parse(&json)?;
    js_sys::Reflect::set(&message, &"payload".into(), &value)?;

    // `postMessage` on the Worker's own global scope — the Worker→page
    // direction. Reached through the global rather than a captured handle
    // because `HostCtx` is constructed per call and holds nothing.
    let global = js_sys::global();
    let post = js_sys::Reflect::get(&global, &"postMessage".into())?;
    let post: js_sys::Function = post.dyn_into()?;
    post.call1(&global, &message)?;
    Ok(())
}
