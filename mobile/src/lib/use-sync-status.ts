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
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** The runtime sync status (mirrors the Rust `SyncRuntimeStatus`). */
export type SyncStatus =
  | { state: "disabled" }
  | { state: "not_enrolled" }
  | { state: "pending" }
  | { state: "idle" }
  | { state: "syncing" }
  | { state: "error"; detail: string }
  | { state: "conflicts"; count: number };

/** Status-poll cadence for the indicator (ms). Cheap read-only command. */
const STATUS_POLL_MS = 5000;

export interface SyncStatusHook {
  /** The current status; `null` until the first read resolves. */
  status: SyncStatus | null;
  /** True while a `410`-beyond-horizon full reconcile is running (SYNC-10). */
  reconciling: boolean;
  /** True after a fork-integrity alert (rejected rollback / forged head); the banner owns dismissal. */
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
    // Reconcile banner: on for the duration of a beyond-horizon full reconcile.
    sub("sync://reconcile-started", () => {
      if (mounted.current) setReconciling(true);
    });
    sub("sync://reconcile-finished", () => {
      if (mounted.current) setReconciling(false);
    });
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

  return { status, reconciling, integrityAlert, syncNow, busy };
}
