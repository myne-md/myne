// `useSyncStatus` — the runtime sync status + manual "sync now" trigger
// (MYND-424 task 10). Wired to the real `sync` Tauri plugin:
// `plugin:sync|sync_status` (read) + `plugin:sync|sync_now` (trigger).
//
// The backend derives the status honestly from whether an endpoint is
// configured until the engine loop is live over a real transport (task 2,
// R3-blocked): `disabled` when unconfigured, else `idle`. The four live states
// (`syncing` / `error` / `conflicts`) light up once the loop lands — this hook's
// API does not change. `syncNow()` shows a brief local `syncing` state for
// responsiveness, then reflects whatever the command returns.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../platform/core";
import { subscribeToEvents } from "../lib/subscribe";

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
       * absent when none ever has. Carried only on `error`, matching the Rust
       * side: how long sync has been broken is a question that only exists
       * while it is broken. Feed it to `isSyncStale`, never to a date format —
       * see `src/lib/sync-staleness.ts` for why.
       */
      last_success_at?: number;
    }
  | { state: "conflicts"; count: number };

/** Status-poll cadence for the indicator (ms). Cheap read-only command. */
const STATUS_POLL_MS = 5000;

export interface SyncStatusHook {
  /** The current status; `null` until the first read resolves. */
  status: SyncStatus | null;
  /** Trigger an immediate sync; resolves with the resulting status. */
  syncNow: () => Promise<void>;
  /** True while a manual `syncNow()` is in flight. */
  busy: boolean;
}

async function readStatus(): Promise<SyncStatus> {
  return invoke<SyncStatus>("plugin:sync|sync_status");
}

export function useSyncStatus(): SyncStatusHook {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setInterval> | undefined;
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
    timer = setInterval(tick, STATUS_POLL_MS);
    // Re-read immediately when enrollment changes (e.g. a local reset) so the
    // indicator does not lag a whole poll interval behind the device panel.
    // Re-read promptly on enrollment changes AND on the engine's status-changed
    // nudge (MYND-461: the loop/sync_now emit `sync://status-changed` when they
    // publish Syncing/Error/clear), so the dot updates without waiting a whole
    // poll interval.
    const unsubscribe = subscribeToEvents(
      ["sync://enrollment-changed", "sync://status-changed"],
      tick,
    );
    return () => {
      mounted.current = false;
      if (timer) clearInterval(timer);
      unsubscribe();
    };
  }, []);

  const syncNow = useCallback(async () => {
    setBusy(true);
    // No optimistic fake `syncing` (MYND-461): the engine now publishes a REAL
    // in-flight `Syncing` state (the loop + sync_now write it to the status cell),
    // so the dot reflects real engine state and the button's `busy` flag alone
    // signals the manual click. Faking `syncing` here would show "Synced ·" become
    // a fake spin even when nothing is really in flight.
    try {
      const next = await invoke<SyncStatus>("plugin:sync|sync_now");
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) {
        setStatus({ state: "error", detail: "sync_failed" });
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  return { status, syncNow, busy };
}
