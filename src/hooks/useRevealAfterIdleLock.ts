// Re-show the window after an idle auto-lock hid it (MYND-121, extended by
// MYND-628).
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
// Permission: `core:window:allow-show`, granted in
// `src-tauri/capabilities/default.json`. Note it is the ONLY window permission
// this may use — `unminimize` is NOT granted, and calling it here would be
// rejected by the Tauri 2 deny-by-default ACL and take `show()` down with it.

import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Reveal the window once a locked surface has mounted.
 *
 * Idempotent on a normal boot — `screen_capture::init` has already shown the
 * window, so this is a no-op there. No-op outside Tauri (browser dev shim).
 */
export function useRevealAfterIdleLock(): void {
  useEffect(() => {
    void (async () => {
      try {
        await getCurrentWindow().show();
      } catch {
        // Not inside Tauri, or no main window to reveal. Nothing actionable:
        // the window simply stays as it was, which is the pre-MYND-121 state.
      }
    })();
  }, []);
}
