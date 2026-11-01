// Re-lock the vault after `auto_lock_seconds` of inactivity. Extracted from
// `app/flows/EditorFlow.tsx` when the approval wait gained a second post-unlock
// screen (myne-md/myne#535's mobile half): two screens now hold live keys
// outside a lock, and a timer that exists in only one of them is the A6 hole the
// web client closed for its own wait screen.
//
// # The two load-bearing properties, kept from the editor's inline copy
//
// **A phone suspends timers the moment the app leaves the foreground**, so time
// spent backgrounded — which is most of the time a phone is unattended, and
// exactly the "lost or stolen device" case auto-lock is for — never counts
// toward a countdown. A `setTimeout` therefore locked the vault 30 seconds after
// the user came BACK rather than 30 seconds after they left (#53). This compares
// TIMESTAMPS instead, and re-evaluates when the app becomes visible again, which
// is the first moment the elapsed time is observable at all. Same shape as the
// shared web timer (`src/hooks/useIdleAutoLock.ts`).
//
// **The envelope has no disable path.** `effectiveMobileAutoLockSecs` clamps to
// [30, 3600], so a sentinel or replayed "off" (0) cannot switch the idle lock
// off (A6, matching desktop's always-on `effective_auto_lock_secs`).

import { useEffect } from "react";
import { HAS_TAURI } from "../lib/app-window";
import { effectiveMobileAutoLockSecs } from "../lib/auto-lock";

/**
 * @param onLock called once when the idle deadline passes; the caller locks.
 * @param autoLockSeconds the raw `auto_lock_seconds` pref, clamped here so both
 *   call sites get the same envelope rather than each clamping its own.
 * @param active `false` disables the timer without breaking the hook order —
 *   a screen that only sometimes holds keys still calls it unconditionally.
 */
export function useIdleAutoLock(
  onLock: (reason: "idle") => void,
  autoLockSeconds: number | null,
  active = true,
): void {
  useEffect(() => {
    if (!HAS_TAURI || !active) return;
    const secs = effectiveMobileAutoLockSecs(autoLockSeconds);
    let lastActivity = Date.now();
    let fired = false;
    const evaluate = () => {
      if (fired) return;
      if (Date.now() - lastActivity >= secs * 1000) {
        fired = true;
        onLock("idle");
      }
    };
    const markActive = () => {
      // After firing, activity does not un-lock: the vault is locked and the
      // unlock screen owns what happens next.
      if (fired) return;
      lastActivity = Date.now();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") evaluate();
    };
    const events: (keyof WindowEventMap)[] = ["touchstart", "keydown", "pointerdown", "mousedown"];
    events.forEach((e) => window.addEventListener(e, markActive, { passive: true }));
    document.addEventListener("visibilitychange", onVisibility);
    // A coarse tick: the deadline is a timestamp comparison, so the interval
    // only decides how promptly a FOREGROUND idle is noticed — the suspended
    // case is handled by the visibility check above.
    const timer = window.setInterval(evaluate, 5000);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      events.forEach((e) => window.removeEventListener(e, markActive));
    };
  }, [autoLockSeconds, onLock, active]);
}
