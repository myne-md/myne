// `useLastActiveNotePref` — the "Continue where you left off" preference
// (MYND-426 task 6).
//
// When ON, the client syncs a `last_active_note` scalar (the note-id ONLY — never
// tab/scroll/pane state, never MYW1) on `vault.prefs`, so reopening on another
// device restores the last note. It is a presence-ish signal (which note, when),
// so the default is OFF (A13) — a conscious opt-in. (Unlike the retired SSE
// toggle — real-time sync is baseline behaviour per the amended §8.3 — this one
// reveals WHICH note, so it stays a toggle.)
//
// ⚠️ MOCK BACKEND (pending the `vault.prefs` `last_active_note` field, staged in
// MYND-426 spec-deltas): the boolean is held in localStorage to keep the toggle
// shippable + testable. When the prefs field lands, replace the localStorage
// read/write with a `usePrefs` field — the component API here stays identical.

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "myne.sync.lastActiveNote";

/** Default OFF — a cross-device "which note, when" signal is a conscious opt-in. */
export const LAST_ACTIVE_NOTE_DEFAULT = false;

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return LAST_ACTIVE_NOTE_DEFAULT;
  }
}

export interface LastActiveNotePref {
  /** When true, sync the `last_active_note` note-id on prefs. */
  enabled: boolean;
  /** Toggle the opt-in (persisted to the mock store pending the prefs field). */
  setEnabled: (next: boolean) => void;
}

export function useLastActiveNotePref(): LastActiveNotePref {
  const [enabled, setState] = useState<boolean>(readStored);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setState(readStored());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* ignore persistence failure — the in-memory state still updates */
    }
  }, []);

  return { enabled, setEnabled };
}
