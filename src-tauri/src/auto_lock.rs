//! Auto-lock-on-idle protective envelope (MYND-121).
//!
//! **The protective ENVELOPE is not here any more** (myne-md/myne#479): the
//! three bounds, their compile-time invariants and the
//! `effective_auto_lock_secs` clamp live in `myne-core`, because two other
//! clients grew their own auto-locks while this module's header said the policy
//! was desktop-only. What this module owns now is the desktop TIMER: the
//! machine-level idle reader, the tick loop that compares idle against the
//! cached timeout, the import-source TTL, and the teardown. The paragraph below
//! described the envelope and is kept for the argument it carries about why the
//! bounds are code constants rather than prefs fields.
//!
//! This module used to own the **code-enforced** part of the auto-lock policy,
//! deliberately NOT stored in the replayable `vault.prefs` blob. The user's
//! chosen timeout (`PrefsView::auto_lock_seconds`) is a *preference*; the
//! always-on flag and the `[MIN, CEILING]` bounds are *code constants*. A
//! disk-level attacker (A4) who replays, deletes, or tampers `vault.prefs`
//! can therefore only make auto-lock **stricter** — never disable it or push
//! it past the ceiling. See `docs/threat-model.md` §7 (two-class prefs
//! taxonomy) and `design-notes.md` 2026-05-30 "Auto-lock on idle".
//!
//! The single entry point, [`effective_auto_lock_secs`], returns a plain
//! `u32` (never an `Option`): there is **no disabled state**. Every possible
//! prefs input — absent, sentinel-shaped `0`, replayed-huge, or in-range —
//! maps to a finite, in-range timeout. That total-ness is the structural
//! realization of the always-on A6 guarantee (stories 16, 18).

use crate::plugins::vault_unlock::state::{Slot, SlotKind, VaultRuntimeState};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

// The protective envelope, its three constants, its compile-time invariants
// and the `effective_auto_lock_secs` clamp, is SHARED, in `myne-core`
// (myne-md/myne#479), and this module deliberately re-exports NONE of it.
//
// It used to live here, under a comment in `core/src/lib.rs` saying "the
// auto-lock *policy enforcement* is desktop-only (`auto_lock` stays in the
// desktop crate)". That sentence stopped being true when mobile and web shipped
// their own auto-locks: both returned `prefs_value.unwrap_or(DEFAULT)` with no
// clamp, so the ceiling's own docstring, "an A4 disk attacker cannot widen the
// A6 exposure window", held on one client and not the other two.
//
// A re-export stood here for one round of this change and then had no consumer,
// because the fix that made the envelope shared also made the trait method
// DEFAULT to it: no client writes the delegation any more, so nothing in this
// crate names the function. The two remaining readers reach for
// `myne_core::AUTO_LOCK_CEILING_SECS` directly, which is the honest path to a
// constant that is not this module's.

/// How long a vault-import SOURCE slot may hold a second vault's key material
/// before the tick above reclaims it (myne-md/myne#464).
///
/// Deliberately generous relative to the auto-lock default, because it is not
/// an idle timeout: an import of a large vault legitimately runs for a long
/// time with the machine untouched, which is exactly why `import_set_hold`
/// exists. This is the CEILING on an import that stopped making progress, not
/// an expected duration, and the frontend closes the slot explicitly on every
/// exit path long before it matters.
///
/// It must stay independent of the import hold. Deriving it from the auto-lock
/// timeout, or gating the sweep on the hold, would hand the second vault's
/// key material the same deferral the target vault's lock gets, and the whole
/// reason this constant exists is that the target's reclaimer is switched off
/// during an import.
const IMPORT_SOURCE_TTL: core::time::Duration = core::time::Duration::from_secs(30 * 60);

// ---- machine-level idle reader (MYND-121, stories 2 + 3) --------------
//
// "Idle" for the A6 guarantee = MACHINE-level device idle (no input to the
// whole machine), read per-platform. Window-level idle (the frontend
// heartbeat → `VaultRuntimeState::idle_millis`) is the FAIL-SECURE fallback
// when no OS source is available (Wayland / unsupported platform): it is
// strictly more eager than machine-idle, so A6 is preserved and only
// usability degrades. The raw OS FFI is best-effort, per-platform
// MANUAL-VERIFY; the deterministic host-testable logic is
// [`effective_idle_from`].

/// Combine the optional machine-level idle with the always-available
/// window-level idle into the effective idle the timer compares against
/// the configured timeout.
///
/// Equivalent to the grill's `now − max(window_last_activity,
/// machine_last_input?)`: any window activity is also machine input, so
/// `machine_last_input >= window_last_activity` — when the machine source
/// is present it is authoritative (`Some` → use it); when absent (Wayland /
/// unsupported) fall back to window-level idle. Pure + deterministic — the
/// host-testable core of this task.
pub fn effective_idle_from(machine_idle: Option<Duration>, window_idle: Duration) -> Duration {
    machine_idle.unwrap_or(window_idle)
}

/// Effective idle = machine-level idle when the OS exposes it, else the
/// window-level fallback. See [`effective_idle_from`] + [`machine_idle`].
pub fn effective_idle(window_idle: Duration) -> Duration {
    effective_idle_from(machine_idle(), window_idle)
}

/// Machine-level idle duration from the OS, or `None` when no portable
/// source exists for this platform / session (→ window-level fallback).
///
/// **Best-effort, per-platform MANUAL-VERIFY** — not unit-tested (the value
/// depends on live device input):
/// - macOS: `CGEventSourceSecondsSinceLastEventType(HIDSystemState, Any)`.
/// - Windows: `GetLastInputInfo` + `GetTickCount` (ms-since-boot, wrap-safe).
/// - Linux: X11 ScreenSaver `QueryInfo.ms_since_user_input`; `None` on a
///   Wayland-only session / no `DISPLAY` → fail-secure window-level fallback.
/// - Other: `None`.
#[cfg(target_os = "macos")]
fn machine_idle() -> Option<Duration> {
    // Stable CoreGraphics C API. No crate dependency — the CoreGraphics
    // framework is already linked (tao → core-graphics); the `#[link]` here
    // is belt-and-suspenders and dedups at link time. `#[link_name]` keeps
    // a snake_case Rust name (no `non_snake_case` lint on the FFI symbol).
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        #[link_name = "CGEventSourceSecondsSinceLastEventType"]
        fn cg_seconds_since_last_event(state_id: u32, event_type: u32) -> f64;
    }
    // kCGEventSourceStateHIDSystemState = 1; kCGAnyInputEventType = 0xFFFFFFFF.
    const HID_SYSTEM_STATE: u32 = 1;
    const ANY_INPUT_EVENT: u32 = 0xFFFF_FFFF;
    // SAFETY: pure C call with POD scalar args (no pointers / allocation).
    // The function is total and returns a CFTimeInterval (seconds) >= 0.
    let secs = unsafe { cg_seconds_since_last_event(HID_SYSTEM_STATE, ANY_INPUT_EVENT) };
    if secs.is_finite() && secs >= 0.0 {
        Some(Duration::from_secs_f64(secs))
    } else {
        None
    }
}

#[cfg(windows)]
fn machine_idle() -> Option<Duration> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        cbSize: core::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is fully initialized with `cbSize` set per the Win32
    // contract; GetLastInputInfo writes `dwTime` and returns BOOL.
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    // GetTickCount and dwTime are both ms-since-boot u32 (wraps ~49.7 days);
    // wrapping_sub yields the correct elapsed delta across a single wrap.
    // SAFETY: GetTickCount is a pure no-arg syscall wrapper.
    let now = unsafe { GetTickCount() };
    Some(Duration::from_millis(u64::from(
        now.wrapping_sub(info.dwTime),
    )))
}

#[cfg(target_os = "linux")]
fn machine_idle() -> Option<Duration> {
    use x11rb::connection::Connection;
    use x11rb::protocol::screensaver::ConnectionExt as _;

    // #271: detect Wayland EXPLICITLY, before touching x11rb.
    //
    // The old comment claimed `connect` fails on a Wayland-only session — and
    // that is exactly what XWayland prevents. Under a Wayland compositor with
    // XWayland running (the default on GNOME and KDE), the connect SUCCEEDS and
    // the screensaver extension answers about the X11 subsystem alone. A user
    // working in native Wayland apps registers no X11 input at all, so the
    // reported idle grows without bound while they are actively typing — and
    // `machine_idle.unwrap_or(window_idle)` prefers this answer over the
    // window-level clock that WOULD have been right. The result is a vault
    // locking mid-sentence, which is the failure that teaches users to raise
    // the timeout.
    //
    // The remedy is to return `None` and let the window-level heartbeat take
    // over: strictly more eager than a correct OS idle, which is the safe
    // direction. Pure-X11 sessions are unchanged.
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v.eq_ignore_ascii_case("wayland"))
    {
        return None;
    }

    // Every step is `?`-on-error, no panic. A failed connect (no DISPLAY, no X
    // server) still falls back to the window-level clock.
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen_num)?.root;
    let info = conn.screensaver_query_info(root).ok()?.reply().ok()?;
    Some(Duration::from_millis(u64::from(info.ms_since_user_input)))
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn machine_idle() -> Option<Duration> {
    None
}

// ---- authoritative idle-lock timer (MYND-121, stories 1/5/6/7) --------

/// Poll interval for the idle-lock timer. A few seconds is ample — the
/// per-tick check is two lock-free reads, a cheap slot peek, and one SHARED
/// -lock probe for an expired vault-import source (myne-md/myne#464); the lock
/// fires within one interval of the deadline. (A `sleep_until(deadline)`
/// refinement is possible later; the periodic poll is simpler and its
/// wakeup cost is negligible.)
///
/// The import probe is deliberately a read acquisition. It runs on every tick
/// for the life of the process, so opening it with `write()` would have put
/// roughly seventeen thousand exclusive acquisitions a day on the one lock
/// every note read, note write and attachment ingest contends on, on a machine
/// that never imports anything.
const IDLE_POLL: Duration = Duration::from_secs(5);

/// Bounded grace between "deadline reached" and the irreversible zeroize,
/// giving the frontend a chance to flush an unsaved edit (task 11 listens
/// for `vault-lock-imminent`). Hard-capped — the lock proceeds when it
/// elapses regardless; and if activity resumes during the grace, the
/// under-lock re-read aborts the lock. Near-nil cost in practice (idle
/// means autosave's debounce has already persisted).
const LOCK_FLUSH_GRACE: Duration = Duration::from_millis(1500);

/// Absolute TTL for the `Slot::Recovering` window (MYND-121 story 8) —
/// measured from `recovered_at`, NOT activity-reset. A generous code
/// constant aligned with the 10-minute vault-creation session TTL
/// (`decisions.md` 2026-04-28; same rationale — bound the RAM-resident
/// recovered `root_key` window). NOT user-tunable / NOT in `vault.prefs`
/// → zero replay surface (the task-3 protective envelope is unneeded here).
const RECOVERING_TTL: Duration = Duration::from_secs(600);

/// Spawn the authoritative idle-lock timer for the process lifetime.
/// FAIL-CLOSED: silence of the activity heartbeat lets the effective idle
/// grow until it crosses the cached timeout, then the vault locks.
///
/// Wired from the app `setup` hook (`lib.rs`). The loop + AppHandle teardown
/// are integration-level — exercised by the running app, not unit tests; the
/// lock decision + TOCTOU drop are unit-tested in `vault_unlock::state`, the
/// idle combine in this module's tests.
pub fn spawn_idle_lock_timer<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(IDLE_POLL);
        loop {
            ticker.tick().await;
            idle_lock_tick(&app).await;
        }
    });
}

/// One idle-lock evaluation tick. Locks the vault iff a vault is `Unlocked`
/// and the effective idle has crossed the cached timeout, routing the drop
/// through the canonical slot-take (`take_unlocked_if_idle`) + the same
/// post-lock teardown as `vault_lock`.
async fn idle_lock_tick<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<VaultRuntimeState>() else {
        return;
    };
    // Peek the active vault's slot kind (cheap read-lock) and dispatch. Each
    // path re-checks under the write-lock before the irreversible drop, so this
    // peek is only a pre-dispatch — a slot change in the gap is handled by the
    // under-lock re-read in the take_* method.
    //
    // TRANSITIONAL (sub-feature 6 — multi-vault auto-lock): operate on the
    // single active (`Unlocked`, else `Recovering`) entry (SYNC-1).
    // The import-source TTL sweep runs FIRST and unconditionally, before the
    // active-slot dispatch, and both properties are the point (myne-md/myne#464).
    //
    // Unconditionally, because a source vault's key material has to be
    // reclaimed whatever the target vault is doing — including while the
    // target is locked, which is the state an abandoned import leaves behind.
    //
    // First, because this is the one reclaimer left running during an import.
    // `import_set_hold` DEFERS the idle lock below for the length of a run, so
    // during exactly the window when TWO vaults' keys are resident, the timer
    // that would otherwise drop one of them is switched off. The sweep is not
    // subject to that hold: it reads the import slot's own `opened_at` against
    // its own TTL, so a hung or abandoned import cannot hold a second vault's
    // keys open indefinitely. That bound is what `threat-model.md` A6 states.
    // `take_import_source_if_expired` probes under the READ lock and takes the
    // write lock only when there is something to drop, so the common case (no
    // import has ever run) costs one shared acquisition rather than an exclusive
    // one. That matters at this call site specifically: it fires every five
    // seconds for the life of the process, on the one lock every note read,
    // note write and attachment ingest contends on.
    myne_core::plugins::vault_unlock::import_source::sweep_expired(
        state.inner(),
        IMPORT_SOURCE_TTL,
        &myne_core::host::tauri_host::TauriHost::new(app.clone()),
    )
    .await;

    let active_kind = match state.active_vault_or_recovering_for_probe().await {
        Some(id) => state.slot_kind(id).await,
        None => SlotKind::Empty,
    };
    match active_kind {
        SlotKind::Unlocked => lock_unlocked_if_idle(app, state.inner()).await,
        SlotKind::Recovering => bail_recovering_if_expired(app, state.inner()).await,
        SlotKind::Empty => {}
        // Unreachable through this resolver rather than merely unhandled:
        // `active_vault_or_recovering_for_probe` resolves an `Unlocked` entry
        // else a `Recovering` one, and deliberately does not see an import
        // source (a vault opened for READING is not the vault this process is
        // working on). The sweep above is where an import slot is acted on.
        SlotKind::ImportSource => {}
    }
}

/// Idle-lock path for `Slot::Unlocked`: lock when the effective idle crosses
/// the cached timeout. Full leg-1 + leg-2 teardown (open notes may be on
/// screen). Fail-closed + grace-flush + TOCTOU re-read.
async fn lock_unlocked_if_idle<R: Runtime>(app: &AppHandle<R>, state: &VaultRuntimeState) {
    // A running import DEFERS the lock (myne-md/myne#223). Deliberately a
    // separate lease rather than a `report_activity` call: the idle clock keeps
    // running underneath, so this postpones the decision instead of resetting
    // it, and the very next tick after the lease lapses locks a vault whose
    // user really did walk away. See `plugins::importer::hold`.
    if let Some(hold) = app.try_state::<crate::plugins::importer::hold::ImportHold>() {
        if hold.is_held() {
            return;
        }
    }

    let timeout = Duration::from_secs(u64::from(state.auto_lock_timeout_secs()));
    // The monotonic clock comes from the host seam now (MYND-574 task 12):
    // `VaultRuntimeState` no longer owns an `Instant` baseline, because
    // capturing one in `Default::default()` panicked on wasm32. Behaviour on
    // desktop is unchanged — `TauriHost::monotonic_millis` is `Instant`-backed.
    // `HostCtx` in scope so `monotonic_millis` resolves on the concrete adapter.
    use myne_core::host::HostCtx as _;
    let host = myne_core::host::tauri_host::TauriHost::new(app.clone());

    // Lock-free pre-check: has the effective idle crossed the timeout?
    if effective_idle(Duration::from_millis(
        state.idle_millis(host.monotonic_millis()),
    )) < timeout
    {
        return;
    }

    // Grace window: let the frontend flush an unsaved edit (task 11). The
    // lock proceeds when it elapses; activity during the grace aborts it at
    // the under-lock re-read below.
    let _ = app.emit("vault-lock-imminent", ());
    tokio::time::sleep(LOCK_FLUSH_GRACE).await;

    // TOCTOU-safe drop: re-read the effective idle UNDER the slot write-lock
    // and zeroize only if still Unlocked + still idle. Same slot-take as
    // vault_lock — not a parallel zeroize path.
    let locked = state
        .take_unlocked_if_idle(timeout, || {
            effective_idle(Duration::from_millis(
                state.idle_millis(host.monotonic_millis()),
            ))
        })
        .await;

    if let Some(prior) = locked {
        debug_assert!(matches!(prior, Slot::Unlocked(_)));
        tracing::info!(
            event = "vault_locked",
            from_slot_kind = "unlocked",
            reason = "idle_timeout",
            "auto-lock on idle dropped the Unlocked slot; Zeroizing fields wipe on Drop"
        );
        // A vault-import SOURCE slot is dropped here too, not only on the
        // manual lock (myne-md/myne#464). `threat-model.md` A6 states the
        // lock-path drop as one of the two bounds on the window in which two
        // vaults' keys are resident, and omitting it here made that sentence
        // false on the ONE path A6's rating actually rests on: a renderer
        // that dies mid-import lets `import_set_hold` lapse within 60 s, the
        // next tick locks the target, and the source's keys would otherwise
        // sit for the remainder of the 30-minute TTL on a device the user is
        // looking at as locked.
        myne_core::plugins::vault_unlock::import_source::close_all(state).await;
        // The backend-held B2B person identity is a Critical-class keypair and
        // must die with the same idle lock that drops the slot (myne-md/myne#698;
        // `threat-model.md` AS21 says "every lock path"). It lives OUTSIDE the
        // slot map, so nothing else on this path reaches it.
        let _ = state.take_person_identity().await;
        let _ = state.take_person_profile().await;
        // Canonical teardown order (decisions 2026-05-30, leg-split): hide
        // (2a, BEFORE zeroize — renderer-independent cover) → zeroize (leg 1)
        // → reapply screen-capture → reload (2b, AFTER zeroize). The window
        // stays hidden until the reloaded frontend re-shows it on the unlock
        // screen (task 11 fresh-load handshake, gated so a hung renderer can
        // never re-expose plaintext).
        run_lock_teardown(&AppTeardown { app }, || {
            drop(prior); // leg 1 — zeroize the keys
                         // Route every plaintext-derived teardown surface through the SAME
                         // managed VaultLifecycleHooks the manual vault_lock path uses (core
                         // vault_unlock::commands), so the idle-auto-lock and manual-lock
                         // teardown lists cannot silently DIVERGE: a new surface added to the
                         // hooks impl is wiped by BOTH paths automatically. This idle leg still
                         // SKIPS persist (decisions.md 2026-05-30 / grill Q5), and
                         // `zeroize_vault_indices` also wipes the feature-gated AI vector store
                         // (see DesktopHooks). Hooks is always registered at setup, so this is
                         // unconditional in practice.
                         //
                         // The skip's old justification — "the indices rebuild on the next
                         // unlock" — is true for note BODIES and was false for attachment docs
                         // (myne#307). A body edit that never persisted leaves a `content_nonce`
                         // mismatch, which forces hydrate to re-decrypt; an `att:` doc has no
                         // nonce of its own, so an out-of-band MYE1 write (OCR backlog, voice
                         // transcript) that only patched the live index was simply gone, and
                         // neither hydrate nor the backlog would re-derive it. Those two
                         // producers now persist for themselves, which is what makes the skip
                         // here safe rather than merely intended.
            if let Some(hooks) = app.try_state::<myne_core::hooks::Hooks>() {
                hooks.zeroize_search_index();
                hooks.zeroize_spell();
                hooks.clear_staged_descriptor();
                hooks.pdf_export_teardown_on_lock();
                // myne#679: the idle auto-lock tears down detached (pop-out) note
                // windows too, so an idle lock leaves no note text on screen in
                // any window (the same guarantee the manual lock gives).
                hooks.detached_windows_teardown_on_lock();
                // live-collab: the idle lock drops live co-editing sessions too,
                // so an idle lock leaves no decrypted session in RAM.
                hooks.live_session_teardown_on_lock();
                hooks.zeroize_vault_indices();
                hooks.zeroize_attachment_refs();
                hooks.abort_active_recording();
            }
        });
    }
}

/// Bail path for `Slot::Recovering` (MYND-121 stories 8/9): drop the recovery
/// session when the ABSOLUTE TTL from `recovered_at` elapses. A transient-
/// state deadline (NOT activity-reset, NOT tunable, NOT in prefs →
/// replay-immune), routed as an automated `recovery-flow.md` §4.3 bail via
/// the same slot-take as `vault_lock`. LEG-1-ONLY — the recovery form has no
/// open notes / no V8 plaintext, so leg-2 hide+reload is moot (drop the slot,
/// then re-apply screen-capture). A timeout firing mid-A8f-commit reuses the
/// existing post-Argon2id slot-peek + `vault.meta` CAS in
/// `vault_complete_recovery` (bail without disk write); the frontend resumes
/// via its existing needs-active-session path on the next commit attempt.
async fn bail_recovering_if_expired<R: Runtime>(app: &AppHandle<R>, state: &VaultRuntimeState) {
    // `recovered_at` is a host monotonic reading in millis rather than an
    // `Instant` (MYND-574 task 12); the age is the difference against a fresh
    // reading from the same clock. `saturating_sub` so a backwards clock step
    // reports age 0 — which DELAYS the bail rather than firing it early, the
    // safe direction for a guard that zeroizes key material.
    let now_ms = myne_core::host::HostCtx::monotonic_millis(
        &myne_core::host::tauri_host::TauriHost::new(app.clone()),
    );
    let bailed = state
        .take_recovering_if_expired(RECOVERING_TTL, |recovered_at| {
            Duration::from_millis(now_ms.saturating_sub(recovered_at))
        })
        .await;

    if let Some(prior) = bailed {
        debug_assert!(matches!(prior, Slot::Recovering { .. }));
        tracing::info!(
            event = "vault_locked",
            from_slot_kind = "recovering",
            reason = "recovering_ttl",
            "auto-lock TTL expired the recovery session; root_key + items_key wipe on Drop"
        );
        drop(prior); // leg 1 — zeroize the recovered keys (leg-1-only: no notes)
        crate::screen_capture::apply(app, true, "lock_reset");
    }
}

/// Side-effects of an idle-lock teardown, abstracted so the leg ORDER is
/// unit-testable (the OS effects themselves — OS window-hide / WebView
/// reload — are runtime / manual-verify).
trait LockTeardown {
    /// Leg 2a — synchronous, renderer-INDEPENDENT visual cover.
    fn hide_window(&self);
    /// Lock-on-default-ON: re-apply native screen-capture protection.
    fn reapply_screen_capture(&self);
    /// Leg 2b — best-effort WebView reload (V8 + DOM teardown).
    fn reload_webview(&self);
}

/// Run the canonical idle-lock teardown order: hide (2a, BEFORE zeroize — so
/// the plaintext pixels vanish even if the renderer is hung) → `zeroize`
/// (leg 1, gated on NOTHING) → reapply screen-capture → reload (2b, AFTER
/// zeroize, best-effort). See `decisions.md` 2026-05-30 (leg-split + order).
fn run_lock_teardown<T: LockTeardown>(t: &T, zeroize: impl FnOnce()) {
    t.hide_window(); // leg 2a — renderer-independent cover, before the wipe
    zeroize(); // leg 1 — unconditional, gated on nothing
    t.reapply_screen_capture();
    t.reload_webview(); // leg 2b — best-effort, after the wipe
}

/// Production [`LockTeardown`] over the main window's `AppHandle`.
struct AppTeardown<'a, R: Runtime> {
    app: &'a AppHandle<R>,
}

impl<R: Runtime> LockTeardown for AppTeardown<'_, R> {
    fn hide_window(&self) {
        // OS-level window hide — does NOT require a live renderer, so the
        // plaintext pixels vanish at the deadline even on a hung WebView.
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.hide();
        }
    }

    fn reapply_screen_capture(&self) {
        crate::screen_capture::apply(self.app, true, "lock_reset");
    }

    fn reload_webview(&self) {
        // Best-effort V8 + DOM teardown. `eval` no-ops on a hung renderer →
        // residual freed-page memory is the accepted A7/A10 boundary, NOT
        // part of the A6 claim (decisions 2026-05-30, leg 2b). The reloaded
        // frontend boots to the unlock screen (slot is Empty) and re-shows
        // the window via the task-11 fresh-load handshake.
        //
        // OPEN A6-RISK (PRD): on macOS the hidden window's last frame may
        // persist in the Cmd+Tab / Mission Control snapshot until the reload
        // repaints — needs per-platform verification (content-protection may
        // already cover it; else blank the native layer pre-hide).
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.eval("window.location.reload()");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- machine/window idle combination (MYND-121) -------------------

    #[test]
    fn effective_idle_uses_machine_when_present() {
        // Machine source authoritative when Some — the window value is
        // ignored (machine input ⊇ window input).
        let eff = effective_idle_from(Some(Duration::from_secs(42)), Duration::from_secs(999));
        assert_eq!(eff, Duration::from_secs(42));
    }

    #[test]
    fn effective_idle_falls_back_to_window_when_machine_absent() {
        // Wayland / unsupported platform → None → window-level (fail-secure).
        let eff = effective_idle_from(None, Duration::from_secs(120));
        assert_eq!(eff, Duration::from_secs(120));
    }

    /// #271: a Wayland session must NOT be read through the X11 screensaver.
    ///
    /// Under a Wayland compositor with XWayland running — the default on GNOME
    /// and KDE — the X11 connect SUCCEEDS and the extension reports the X11
    /// subsystem's idle alone. A user working in native Wayland apps registers
    /// no X11 input, so that number grows without bound while they type, and
    /// `machine_idle.unwrap_or(window_idle)` prefers it over the window clock
    /// that would have been right. The vault locks mid-sentence.
    ///
    /// Asserting `None` from the environment rather than from a live session:
    /// the detection IS the fix, and it is decidable without a display.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_wayland_session_reports_no_machine_idle() {
        // `set_var` is unsafe on 2024 edition (process-global). This test is
        // single-threaded over its own variables and restores them.
        let prior_wl = std::env::var_os("WAYLAND_DISPLAY");
        let prior_type = std::env::var_os("XDG_SESSION_TYPE");
        unsafe {
            std::env::set_var("WAYLAND_DISPLAY", "wayland-0");
            std::env::remove_var("XDG_SESSION_TYPE");
        }
        assert_eq!(
            machine_idle(),
            None,
            "a Wayland session must fall back to the window-level clock"
        );

        unsafe {
            std::env::remove_var("WAYLAND_DISPLAY");
            std::env::set_var("XDG_SESSION_TYPE", "Wayland");
        }
        assert_eq!(
            machine_idle(),
            None,
            "XDG_SESSION_TYPE is the other signal, and it is case-insensitive"
        );

        unsafe {
            match prior_wl {
                Some(v) => std::env::set_var("WAYLAND_DISPLAY", v),
                None => std::env::remove_var("WAYLAND_DISPLAY"),
            }
            match prior_type {
                Some(v) => std::env::set_var("XDG_SESSION_TYPE", v),
                None => std::env::remove_var("XDG_SESSION_TYPE"),
            }
        }
    }

    #[test]
    #[ignore] // manual: depends on live device input; run on a real GUI session
    fn machine_idle_smoke() {
        // On a real macOS GUI session this returns Some(small) right after
        // input. Best-effort FFI smoke — not asserted in CI (env-dependent).
        let _ = machine_idle();
    }

    // ---- multi-vault idle-lock bridge: sole `Unlocked` entry (MYND-207) ----
    //
    // Sub-feature 2 swapped the singleton `RwLock<Slot>` for
    // `RwLock<HashMap<VaultId, Slot>>` and repointed the idle-lock tick to act
    // on the SOLE `Unlocked` entry (resolved min-by-id) via the SAME
    // `take_unlocked_if_idle` slot-take. These tests confirm the idle decision
    // reads that one HashMap entry — keyed under a NON-legacy id, with a
    // `Recovering` sibling present — using the cached SINGLETON
    // `auto_lock_timeout_secs`, identical to the single-vault behaviour. They
    // reproduce the lock-free pre-check + under-lock re-read of
    // `lock_unlocked_if_idle` without an `AppHandle` (the teardown OS effects
    // are runtime / manual-verify; the leg ORDER is covered separately above).

    use crate::plugins::vault_unlock::state::{
        fixture_recovering_with_keys, fixture_unlocked_with_keys, test_vault_id, test_vault_id_b,
    };

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    #[test]
    fn idle_tick_locks_the_sole_unlocked_hashmap_entry_using_cached_timeout() {
        // The idle decision acts on the SOLE `Unlocked` entry of the HashMap,
        // using the cached singleton `auto_lock_timeout_secs` (= the active
        // vault's value, set at its unlock). Unlock a vault under a NON-legacy
        // id (so this is a real HashMap lookup, not a singleton), cache a
        // timeout, then drive the SAME idle-decision the tick takes: idle >=
        // cached timeout → the sole entry locks.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let active = test_vault_id_b(); // non-legacy id → genuine HashMap key

            state
                .set_unlocked(active, fixture_unlocked_with_keys(0x21, 0x22, 0x23))
                .await;
            // Cache the active vault's effective timeout (5s) — the singleton
            // atom the idle timer reads lock-free each tick.
            state.set_auto_lock_timeout_secs(5);
            let timeout = Duration::from_secs(u64::from(state.auto_lock_timeout_secs()));
            assert_eq!(timeout, Duration::from_secs(5));

            // Reproduce `lock_unlocked_if_idle`'s under-lock take: idle (injected
            // 10s) >= cached timeout (5s) → lock the sole Unlocked entry.
            let locked = state
                .take_unlocked_if_idle(timeout, || Duration::from_secs(10))
                .await;
            assert!(
                matches!(locked, Some(Slot::Unlocked(_))),
                "idle past the cached timeout must lock the sole Unlocked entry"
            );
            // That one entry is now Empty; no other vault was ever Unlocked.
            assert_eq!(state.slot_kind(active).await, SlotKind::Empty);
            assert_eq!(state.unlocked_entry_count().await, 0);
        });
    }

    #[test]
    fn idle_tick_does_not_lock_the_sole_unlocked_entry_within_cached_timeout() {
        // Identical-to-single-vault: when idle < cached timeout the sole
        // `Unlocked` HashMap entry stays Unlocked (the lock-free pre-check that
        // `lock_unlocked_if_idle` does before any teardown).
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let active = test_vault_id_b();
            state
                .set_unlocked(active, fixture_unlocked_with_keys(0x21, 0x22, 0x23))
                .await;
            state.set_auto_lock_timeout_secs(300);
            let timeout = Duration::from_secs(u64::from(state.auto_lock_timeout_secs()));

            let locked = state
                .take_unlocked_if_idle(timeout, || Duration::from_secs(1))
                .await;
            assert!(
                locked.is_none(),
                "idle below the cached timeout must NOT lock"
            );
            assert_eq!(state.slot_kind(active).await, SlotKind::Unlocked);
        });
    }

    #[test]
    fn idle_tick_resolution_picks_unlocked_then_recovering_then_empty() {
        // The tick's dispatch (`active_vault_or_recovering_for_probe` →
        // `slot_kind`): with an `Unlocked` entry it acts on that; with only a
        // `Recovering` entry it bails THAT via the absolute TTL; an all-`Empty`
        // map is skipped. Confirms a `Recovering` sibling never shadows the
        // `Unlocked` entry, and the `RECOVERING_TTL` bail still applies per
        // entry.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let id_unlocked = test_vault_id();
            let id_recovering = test_vault_id_b();

            // Unlocked beside Recovering → the probe resolves the Unlocked one.
            state
                .set_recovering(
                    id_recovering,
                    fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                )
                .await;
            state
                .set_unlocked(id_unlocked, fixture_unlocked_with_keys(0x21, 0x22, 0x23))
                .await;
            assert_eq!(
                state.active_vault_or_recovering_for_probe().await,
                Some(id_unlocked),
                "the idle tick acts on the Unlocked entry, not the Recovering sibling"
            );

            // Lock the Unlocked entry; now ONLY the Recovering entry remains →
            // the probe resolves it, and the absolute-TTL bail applies to it
            // (injected age >= RECOVERING_TTL).
            let _ = state
                .take_unlocked_if_idle(Duration::ZERO, || Duration::from_secs(10))
                .await;
            assert_eq!(
                state.active_vault_or_recovering_for_probe().await,
                Some(id_recovering),
                "with no Unlocked entry the tick falls through to the Recovering one"
            );
            let bailed = state
                .take_recovering_if_expired(RECOVERING_TTL, |_| RECOVERING_TTL)
                .await;
            assert!(
                matches!(bailed, Some(Slot::Recovering { .. })),
                "the per-entry RECOVERING_TTL absolute bail still fires"
            );

            // All-Empty map → the probe resolves None (tick skips, no panic).
            assert_eq!(state.active_vault_or_recovering_for_probe().await, None);
        });
    }

    // ---- teardown leg ordering (MYND-121 task 7) ----------------------

    #[test]
    fn teardown_runs_hide_then_zeroize_then_reapply_then_reload() {
        use core::cell::RefCell;

        struct Recording {
            log: RefCell<Vec<&'static str>>,
        }
        impl LockTeardown for Recording {
            fn hide_window(&self) {
                self.log.borrow_mut().push("hide");
            }
            fn reapply_screen_capture(&self) {
                self.log.borrow_mut().push("reapply");
            }
            fn reload_webview(&self) {
                self.log.borrow_mut().push("reload");
            }
        }

        let r = Recording {
            log: RefCell::new(Vec::new()),
        };
        // The `zeroize` closure stands in for `drop(prior)`; recording it
        // makes the leg-1 position observable in the order.
        run_lock_teardown(&r, || r.log.borrow_mut().push("zeroize"));
        assert_eq!(
            *r.log.borrow(),
            ["hide", "zeroize", "reapply", "reload"],
            "leg 2a (hide) must precede leg 1 (zeroize); reload (2b) must follow zeroize"
        );
    }
}
