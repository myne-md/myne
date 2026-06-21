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
    let unlisten: (() => void) | undefined;
    void listen("sync://enrollment-changed", tick).then((fn) => {
      if (mounted.current) unlisten = fn;
      else fn();
    });
    return () => {
      mounted.current = false;
      if (timer) clearInterval(timer);
      unlisten?.();
    };
  }, []);

  const syncNow = useCallback(async () => {
    setBusy(true);
    // Optimistic: show a brief active state so the click feels responsive.
    setStatus((prev) => (prev?.state === "disabled" ? prev : { state: "syncing" }));
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
