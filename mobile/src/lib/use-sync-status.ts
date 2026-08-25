// `useSyncStatus` — the mobile runtime sync status + manual "sync now" trigger,
// and the SINGLE data source for every mobile sync surface (glyph, status
// detail, reconcile banner, integrity banner, conflicts). Ports the desktop
// `src/hooks/useSyncStatus.ts` 1:1 and adds the reconcile + integrity-alert
// signals the mobile banners read.
//
// Consumes the shared-core status producers (MYND-461) over the mobile-registered
// `sync` plugin (MYND-458); assumes the MYND-460 loop is driving cycles. Transient
// read failures leave the last-known status — the engine reports its own `error`.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../platform/core";
import { listen } from "../platform/event";

/** The runtime sync status (mirrors the Rust `SyncRuntimeStatus`). */
export type SyncStatus =
  | { state: "disabled" }
  | { state: "not_enrolled" }
  | { state: "pending" }
  | { state: "idle" }
  | { state: "syncing" }
  | {
      state: "error";
      detail: string;
      /**
       * Epoch ms of the last cycle that completed on this device (myne#583),
       * absent when none ever has. The desktop twin carries the same field and
       * the same rule: it feeds a threshold, never a rendered date — mobile is
       * where the no-wall-clock rule (AS6/AS15) is stated most explicitly.
       */
      last_success_at?: number;
    }
  | { state: "conflicts"; count: number };

/** Status-poll cadence for the indicator (ms). Cheap read-only command. */
const STATUS_POLL_MS = 5000;

export interface SyncStatusHook {
  /** The current status; `null` until the first read resolves. */
  status: SyncStatus | null;
  /** True once a `410`-beyond-horizon full reconcile has HAPPENED (SYNC-10).
   *  Not a live bracket: the producer emits both of its events after the fact,
   *  so "during" is not observable (#48). Cleared by {@link dismissReconcile}. */
  reconciling: boolean;
  /** True after a fork-integrity alert (rejected rollback / forged head); the banner owns dismissal. */
  /** Clear the reconcile notice — the banner's dismiss. */
  dismissReconcile: () => void;
  integrityAlert: boolean;
  /** Trigger an immediate sync. */
  syncNow: () => Promise<void>;
  /** True while a manual `syncNow()` is in flight. */
  busy: boolean;
}

async function readStatus(): Promise<SyncStatus> {
  return invoke<SyncStatus>("plugin:sync|sync_status");
}

export function useSyncStatus(): SyncStatusHook {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [integrityAlert, setIntegrityAlert] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const tick = () => {
      readStatus()
        .then((s) => {
          if (mounted.current) setStatus(s);
        })
        .catch(() => {
          /* leave the last-known status; a transient read failure is not an
             engine error — the engine reports its own `error` state. */
        });
    };
    tick();
    const timer = setInterval(tick, STATUS_POLL_MS);

    const unlisteners: Array<() => void> = [];
    const sub = (ev: string, fn: () => void) => {
      void listen(ev, fn).then((u) => {
        if (mounted.current) unlisteners.push(u);
        else u();
      });
    };
    // Re-read promptly on enrollment changes AND the engine's status-changed
    // nudge (MYND-461) so the surfaces don't lag a whole poll interval.
    sub("sync://enrollment-changed", tick);
    sub("sync://status-changed", tick);
    // Reconcile banner: ARMED by both events, exactly as desktop does (#48).
    //
    // These were treated as a live bracket — `started` → true, `finished` →
    // false — but the producer emits BOTH after the fact, in the same tick, at
    // the end of the reconcile. So the banner turned on and off inside one
    // event-loop turn and could never be seen: a device that had just silently
    // re-downloaded and re-reconciled the whole vault showed the user nothing,
    // including when notes were reshuffled or quarantined by it.
    //
    // Cleared by the banner's own dismiss, not by an event.
    const armReconcile = () => {
      if (mounted.current) setReconciling(true);
    };
    sub("sync://reconcile-started", armReconcile);
    sub("sync://reconcile-finished", armReconcile);
    // Fork-integrity alert (rejected rollback / forged head, the Rust-side
    // SYNC-10 verdict) — flipped true here; the integrity banner owns dismissal.
    sub("sync://integrity-alert", () => {
      if (mounted.current) setIntegrityAlert(true);
    });

    return () => {
      mounted.current = false;
      clearInterval(timer);
      for (const fn of unlisteners) fn();
    };
  }, []);

  const syncNow = useCallback(async () => {
    setBusy(true);
    // No optimistic fake `syncing` (MYND-461): the engine publishes a REAL
    // in-flight `Syncing` state (the loop + sync_now write it to the status
    // cell), so the surfaces reflect real engine state and `busy` alone signals
    // the manual click.
    try {
      const next = await invoke<SyncStatus>("plugin:sync|sync_now");
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) setStatus({ state: "error", detail: "sync_failed" });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  return {
    status,
    reconciling,
    // #48: the banner owns dismissal now that no event clears the flag.
    dismissReconcile: () => setReconciling(false),
    integrityAlert,
    syncNow,
    busy,
  };
}
