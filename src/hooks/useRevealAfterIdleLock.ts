// Re-show the window after an idle auto-lock hid it (MYND-121, extended by
// MYND-628 and by myne-md/myne#483).
//
// Idle auto-lock's canonical teardown (`decisions.md` 2026-05-30, leg-split) is
// hide (leg 2a) → zeroize (leg 1) → re-apply screen-capture → WebView reload
// (leg 2b). Leg 2a is a native `window.hide()` — `orderOut:` on macOS — chosen
// over an in-WebView overlay precisely because it is renderer-INDEPENDENT: the
// plaintext pixels go at the deadline even if the WebView is hung. Nothing on
// the Rust side ever shows the window again (`screen_capture::init` owns the
// startup `show()` and runs once per process, inside `Builder::setup`), so the
// reloaded frontend has to ask for it back.
//
// **The gate is the safety property, and it is the screen itself.** Only a
// surface that structurally cannot be showing note plaintext may call this. A
// hung renderer never reaches such a screen, so it never re-exposes anything —
// that is the whole argument, and it is why this is a hook called from specific
// screens rather than an effect in App.tsx that fires on any resolved stage.
//
// **Why it is a shared hook (MYND-628).** It used to live inline in
// `Unlock.tsx`, which is correct but incomplete: `initialStageFromProbe` routes
// a boot with TWO OR MORE vaults to `picker`, not `unlock` (`src/lib/stage.ts`
// — the SYNC-7a rule). `VaultPicker` had no reveal, so for any multi-vault user
// an idle auto-lock hid the window and nothing ever brought it back — the only
// ways out were the macOS dock-icon `RunEvent::Reopen` handler or relaunching
// (`src-tauri/src/lib.rs`). On a full-screen window `orderOut:` also leaves its
// Space blank, which is what made it read as the app vanishing onto a black
// desktop. One hook, called from every locked boot surface, so the next screen
// added to that set cannot silently miss it.
//
// `welcome` is deliberately NOT in that set: it is only reachable with zero
// vaults on disk, and you cannot idle-lock a vault you do not have.
//
// **The show is only half of it, and the half it was missing is why it moved
// host-side (myne-md/myne#483).** The teardown's re-apply runs at step 3, while
// the window is HIDDEN, and the Windows capture affinity is reported not to
// survive a hide/show cycle (tauri-apps/tauri#14189; the same defect Electron
// fixed in electron/electron#45868). So this is the FOURTH re-show site in the
// app, and the one that matters most: the screen it reveals carries the account
// number. An earlier revision kept `getCurrentWindow().show()` here and called a
// separate re-assert after it, which is the same two-independent-calls shape the
// other three sites had. An ordering held by a comment. It now asks the host
// for the one sequence all four share (`screen_capture::show_protected`), so the
// ordering is a property of the code rather than of this comment.
//
// Permission: `screen-capture:allow-screen-capture-show-protected`. That grant
// REPLACED `core:window:allow-show`, which was dropped from
// `src-tauri/capabilities/default.json` in the same change because this hook was
// its only consumer in the tree. The trade is in the right direction: a raw
// window operation page context could aim anywhere, for one fixed
// protect/show/protect/focus sequence it cannot parameterise. `unminimize` is
// inside that sequence and remains unreachable as a standalone grant.

import { useEffect } from "react";
import { showWindowProtected } from "../lib/screen-capture-override";
import { has } from "../platform/capabilities";

/**
 * Reveal the window once a locked surface has mounted.
 *
 * Idempotent on a normal boot — `screen_capture::init` has already shown the
 * window, so this is a no-op there.
 *
 * On the web client this returns before asking anything. A page has no hidden
 * window (web auto-lock re-renders the locked surface in the same tab rather
 * than taking one away) and no capture affinity to lose, so the capability is
 * absent and the guard below is what keeps a guaranteed-refused Worker round
 * trip off every locked mount.
 */
export function useRevealAfterIdleLock(): void {
  useEffect(() => {
    // Where there is no window to reveal there is nothing to ask for. Without
    // this, every locked-surface mount on web made a Worker round trip to be
    // told `Unsupported`, for an answer the capability set already had.
    if (!has("screenCaptureProtection")) return;
    void (async () => {
      try {
        await showWindowProtected();
      } catch (e) {
        // Reported rather than swallowed. This is the only thing that brings
        // the window back after idle auto-lock hid it, and its failure mode is
        // an app that looks frozen in the dock with no log line saying why.
        // A wrong or missing `screen-capture:allow-screen-capture-show-protected`
        // grant lands exactly here, and the ACL has no test that would catch it
        // for us.
        console.warn("reveal-after-idle-lock: the host refused the re-show", e);
      }
    })();
  }, []);
}
