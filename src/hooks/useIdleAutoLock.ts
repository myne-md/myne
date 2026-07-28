// Idle auto-lock driven from the page (phase3-web-client task 43).
//
// # Why this exists only where the OS one does not
//
// Desktop locks on **OS-level idle detection** (`src-tauri/src/auto_lock.rs`):
// the compositor knows when the user stopped touching the machine, including
// while Myne is not focused. A browser is told none of that. So this hook runs
// exactly where `osIdleAutoLock` is absent from the capability descriptor, and
// it is deliberately NOT presented as the same thing — `threat-model.md` A6 is
// qualified per client for this reason (task 4): a page-driven timer is weaker,
// and the threat model says so rather than the code pretending otherwise.
//
// # The trap: a background tab's timers are throttled
//
// Browsers clamp `setTimeout` in a hidden tab to roughly once per minute, and
// may suspend it entirely under memory pressure. A countdown built from ticks
// therefore **stops counting** exactly when the user has walked away — the
// situation auto-lock exists for, turned into the situation it silently skips.
//
// So nothing here counts ticks. Every decision compares **timestamps**:
// `now - lastActivity` against the timeout. Throttling can then delay a lock but
// can never cancel one, and the two paths that matter are covered from opposite
// ends — a `visibilitychange` back into the tab evaluates immediately (a tab
// suspended for an hour locks the instant it is looked at), and while visible
// the tick is frequent enough that the lock lands near the deadline.
//
// # What "locked" has to mean
//
// The callback is expected to do what the Lock button does: flush, then call the
// backend `lock`, which drops the slot and zeroizes `root_key` / `items_key` in
// the Worker, and then transition the UI away from the editor so the plaintext
// is **unmounted** rather than hidden. A hook that only routed the UI would
// leave the keys live in the Worker and the note text in a detached DOM node.

import { useEffect, useRef } from "react";
import { has } from "../platform/capabilities";

/** How often to evaluate while the tab is visible. */
const TICK_MS = 5_000;

/**
 * The events that count as activity. Deliberately coarse: this is "is the user
 * here", not analytics, and every extra listener is another thing running on
 * every keystroke.
 *
 * `visibilitychange` is NOT here — becoming visible is not activity, it is the
 * moment to *evaluate*. Treating it as activity would let a tab that was hidden
 * past its deadline reset itself just by being looked at, which is the exact
 * failure this hook is written to avoid.
 */
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

export interface IdleAutoLockOptions {
  /** Idle timeout in seconds. `0` (or less) disables locking entirely. */
  timeoutSecs: number;
  /** Called once when the idle deadline has passed. Must flush, lock and route. */
  onIdle: () => void;
  /** Escape hatch for tests and for callers that own their own gating. */
  enabled?: boolean;
}

/**
 * Lock when the user has been idle for `timeoutSecs`.
 *
 * No-op where the platform has OS-level idle detection — desktop keeps its own
 * mechanism, and running both would mean two things racing to lock the same
 * vault.
 */
export function useIdleAutoLock({ timeoutSecs, onIdle, enabled }: IdleAutoLockOptions): void {
  // Refs, not state: activity fires on every keystroke and a re-render per
  // keystroke would be a real cost in the editor. Nothing here is rendered.
  const lastActivity = useRef(Date.now());
  const fired = useRef(false);
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  const active = (enabled ?? !has("osIdleAutoLock")) && timeoutSecs > 0;

  useEffect(() => {
    if (!active) return;

    lastActivity.current = Date.now();
    fired.current = false;

    const evaluate = () => {
      if (fired.current) return;
      // Timestamp comparison, never a decremented counter — see the header.
      if (Date.now() - lastActivity.current >= timeoutSecs * 1000) {
        fired.current = true;
        onIdleRef.current();
      }
    };

    const markActive = () => {
      // After firing, activity does not un-lock: the vault is locked and the
      // unlock screen owns what happens next.
      if (fired.current) return;
      lastActivity.current = Date.now();
    };

    const onVisibility = () => {
      // The load-bearing half. A hidden tab's timer may have been throttled to
      // nothing; this is the point where elapsed time is finally observable, so
      // it is evaluated before anything else can be typed.
      if (document.visibilityState === "visible") evaluate();
    };

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, markActive, { passive: true });
    }
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(evaluate, TICK_MS);

    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, markActive);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [active, timeoutSecs]);
}
