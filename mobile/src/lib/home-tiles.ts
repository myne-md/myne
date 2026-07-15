// Home quick-action tile visibility (MYND-479). The three home tiles
// (Templates / Open Today / Views) can each be hidden individually from
// Settings → Appearance. This is a device-local layout preference, so it lives
// in localStorage (not the synced vault prefs) — no prefs-format change — with a
// tiny pub/sub so the home screen re-renders the instant a Settings toggle flips.

import { useEffect, useState } from "react";

export type HomeTileId = "templates" | "open-today" | "views";

const KEY = "myne.home-tiles-hidden";
const listeners = new Set<() => void>();

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** Hide or show one home tile; notifies every `useHiddenHomeTiles` subscriber. */
export function setHomeTileHidden(id: HomeTileId, hidden: boolean): void {
  const cur = read();
  const next = hidden ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode — the toggle just won't persist */
  }
  listeners.forEach((l) => l());
}

/** The set of currently-hidden home tile ids, live. */
export function useHiddenHomeTiles(): Set<string> {
  const [v, setV] = useState<Set<string>>(() => new Set(read()));
  useEffect(() => {
    const l = () => setV(new Set(read()));
    listeners.add(l);
    window.addEventListener("storage", l); // cross-context safety
    return () => {
      listeners.delete(l);
      window.removeEventListener("storage", l);
    };
  }, []);
  return v;
}
