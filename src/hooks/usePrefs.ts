// `usePrefs` — lazy-loading hook for the v0.1 prefs blob (MYND-160).
//
// Lifecycle:
// - Mount: idle state, fires `prefsRead()` once. Cancelled-flag
//   cleanup pattern handles React 19 StrictMode double-mount
//   correctly (the second mount issues a fresh request; only the
//   non-cancelled response updates state).
// - Optimistic write: cache is updated synchronously, then the IPC
//   fires. On rejection, the cache is **re-read from disk** (the
//   authoritative source) so rapid-toggle races between two failing
//   writes converge UI back to disk truth instead of inverting on
//   captured-previous snapshots.
// - Modal close: parent component unmounts the consumer, the hook's
//   state drops, next mount re-reads. No persistent cache across
//   SettingsModal lifecycles — disk is canonical (MYND-160 grill Q5.1).
//
// React Query / SWR is intentionally NOT introduced — the cache shape
// is trivial (1 bool today) and the lifetime is modal-scoped. Per
// `CLAUDE.md` minimal-dep posture (TB9 audit anchor). When prefs grow
// past ~5 fields, revisit (separate PRD).

import { useCallback, useEffect, useState } from "react";
import {
  PrefsView,
  prefsRead,
  setAutoLockTimeout,
  setScreenCaptureProtection,
} from "../lib/prefs";

/**
 * Default prefs returned before the first read completes AND on any
 * load error. Mirrors `PrefsView::default()` on the Rust side
 * (spec § 9.5.5 safer-state semantic).
 */
const DEFAULT_PREFS: PrefsView = {
  screen_capture_protection: true,
  deliberate_folders: [],
  auto_lock_seconds: null,
  note_order: [],
  folder_order: [],
};

interface UsePrefsResult {
  /** Current prefs view — DEFAULT_PREFS until loaded. */
  prefs: PrefsView;
  /**
   * Toggle screen_capture_protection. Optimistic: cache flips
   * immediately. On IPC rejection, the cache is re-read from disk
   * (authoritative truth) and `onError` is called (typically wired
   * to a toast).
   */
  toggleScreenCapture: (enabled: boolean) => Promise<void>;
  /**
   * Set the auto-lock-on-idle timeout (seconds). Optimistic: cache updates
   * immediately. On IPC rejection, the cache is re-read from disk
   * (authoritative truth) and `onError` is called (typically a toast).
   * Same pattern as `toggleScreenCapture`.
   */
  setAutoLock: (seconds: number) => Promise<void>;
}

/**
 * `onError` is the toast hook — invoked when an optimistic write
 * rolled back. The parent threads this from
 * `SettingsModal.onShowToast`.
 */
export function usePrefs(onError?: (message: string) => void): UsePrefsResult {
  const [prefs, setPrefs] = useState<PrefsView>(DEFAULT_PREFS);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const view = await prefsRead();
        if (!cancelled) {
          setPrefs(view);
        }
      } catch {
        // SlotNotUnlocked / Io / InvalidVaultMeta → keep DEFAULT_PREFS
        // (safer state per spec § 9.5.5). The error is observable in
        // the backend tracing; the frontend treats it as "couldn't
        // load, use defaults" and stays usable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleScreenCapture = useCallback(
    async (enabled: boolean) => {
      // Optimistic flip via functional update so concurrent toggles
      // each see the latest visual state when computing their next
      // value (no captured-previous staleness).
      setPrefs((p) => ({ ...p, screen_capture_protection: enabled }));
      try {
        await setScreenCaptureProtection(enabled);
      } catch {
        // Re-read disk truth instead of rolling back to a captured
        // pre-flip value. Pattern fixes the rapid-double-toggle UI/
        // disk inversion case (T1 optimistic-then-fail captures stale
        // baseline from T0's optimistic state; T2 rollback would
        // invert UI vs disk). Re-reading converges UI with disk on
        // every error path, regardless of how many concurrent writes
        // raced.
        try {
          const view = await prefsRead();
          setPrefs(view);
        } catch {
          // Re-read also failed — keep the optimistic value; the
          // backend tracing has logged the original failure. User can
          // retry by toggling again.
        }
        onError?.("Couldn't save preference — try again");
      }
    },
    [onError],
  );

  const setAutoLock = useCallback(
    async (seconds: number) => {
      // Optimistic via functional update (no captured-previous staleness).
      setPrefs((p) => ({ ...p, auto_lock_seconds: seconds }));
      try {
        await setAutoLockTimeout(seconds);
      } catch {
        // Re-read disk truth instead of rolling back to a captured value —
        // same convergence discipline as `toggleScreenCapture`.
        try {
          const view = await prefsRead();
          setPrefs(view);
        } catch {
          // Re-read also failed — keep the optimistic value; the backend
          // tracing logged the original failure. User can retry.
        }
        onError?.("Couldn't save preference — try again");
      }
    },
    [onError],
  );

  return { prefs, toggleScreenCapture, setAutoLock };
}
