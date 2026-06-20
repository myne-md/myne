// `useSyncPrefs` — the real-time-sync (SSE) preference (MYND-423 UI).
//
// Polling is the privacy-default baseline; SSE is an OPT-IN low-latency layer
// (an open SSE is a continuous presence signal — A13 — so the default is OFF).
// This hook owns ONLY that one boolean.
//
// ⚠️ MOCK BACKEND (pending MYND-424): the sync engine + the vault.prefs field
// that will persist this do not exist yet. To keep the UI shippable + testable
// without backend drift, the value is held in localStorage. When MYND-424 lands,
// replace the localStorage read/write with a `vault.prefs` field via `usePrefs`
// (the per-vault, disk-canonical path) — the component API here stays identical.

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "myne.sync.realtimeSse";

/** Default OFF — polling is the privacy-default; SSE is a conscious opt-in. */
export const REALTIME_SSE_DEFAULT = false;

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return REALTIME_SSE_DEFAULT;
  }
}

export interface SyncPrefs {
  /** When true, the client opens an opt-in SSE poke channel for low latency. */
  realtimeSse: boolean;
  /** Toggle the SSE opt-in (persisted to the mock store pending MYND-424). */
  setRealtimeSse: (next: boolean) => void;
}

export function useSyncPrefs(): SyncPrefs {
  const [realtimeSse, setState] = useState<boolean>(readStored);

  // Re-sync if another surface (or tab) changed the value.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setState(readStored());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setRealtimeSse = useCallback((next: boolean) => {
    setState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      // best-effort; the in-memory state still reflects the choice this session
    }
  }, []);

  return { realtimeSse, setRealtimeSse };
}
