// Sidebar customization (owner, 2026-11-27 polish round: "iPad'de bu sidebar
// aynı bizim left ribbon gibi customizable olması lazım, kişiye göre çok
// customizable olması lazım").
//
// DEVICE-LOCAL, like the home tiles (`lib/home-tiles.ts`): which destinations a
// person keeps in their ribbon is a layout preference of THIS device's screen,
// not a property of the vault, so it lives in `localStorage` and never enters the
// synced prefs. A phone and an iPad can therefore carry different ribbons without
// a prefs-format change or a sync conflict.

import { useEffect, useState } from "react";

export type RibbonItemId =
  | "search"
  | "tasks"
  | "note-tasks"
  | "graph"
  | "calendar"
  | "files"
  | "templates"
  | "views"
  | "tags"
  | "archive"
  | "trash"
  | "chat";

/** Canonical order. `all-notes` and `settings` are NOT in the list: they are the
 *  ribbon's fixed head and foot, so the ribbon can never be emptied into a bare
 *  strip with no way back to the notes list or to Settings. */
export const RIBBON_ORDER: readonly RibbonItemId[] = [
  "search",
  "tasks",
  "note-tasks",
  "graph",
  "calendar",
  "files",
  "templates",
  "views",
  "tags",
  "archive",
  "trash",
  "chat",
];

const KEY = "myne.ribbon-layout";
const listeners = new Set<() => void>();

export interface RibbonLayout {
  hidden: RibbonItemId[];
  /** Full order, always a permutation of `RIBBON_ORDER`. A stored order that is
   *  missing an id (a build that added one) or names an id a later build dropped
   *  is REPAIRED on read rather than trusted, so a stale layout never hides a
   *  destination permanently. */
  order: RibbonItemId[];
}

function isId(v: unknown): v is RibbonItemId {
  return typeof v === "string" && (RIBBON_ORDER as readonly string[]).includes(v);
}

function repair(order: unknown, hidden: unknown): RibbonLayout {
  const storedOrder = Array.isArray(order) ? order.filter(isId) : [];
  const seen = new Set<RibbonItemId>();
  const repairedOrder: RibbonItemId[] = [];
  for (const id of storedOrder) {
    if (seen.has(id)) continue;
    seen.add(id);
    repairedOrder.push(id);
  }
  for (const id of RIBBON_ORDER) if (!seen.has(id)) repairedOrder.push(id);
  const storedHidden = Array.isArray(hidden) ? hidden.filter(isId) : [];
  return { hidden: [...new Set(storedHidden)], order: repairedOrder };
}

function read(): RibbonLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as {
      order?: unknown;
      hidden?: unknown;
    };
    return repair(raw.order, raw.hidden);
  } catch {
    return repair([], []);
  }
}

function write(next: RibbonLayout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode — the edit just will not persist */
  }
  listeners.forEach((l) => l());
}

/** Hide or show one ribbon destination. */
export function setRibbonItemHidden(id: RibbonItemId, hidden: boolean): void {
  const cur = read();
  const nextHidden = hidden
    ? cur.hidden.includes(id)
      ? cur.hidden
      : [...cur.hidden, id]
    : cur.hidden.filter((x) => x !== id);
  write({ ...cur, hidden: nextHidden });
}

/** Move one destination one slot up (`-1`) or down (`+1`). Moves swap with the
 *  nearest VISIBLE neighbour, so a hidden item between two shown ones cannot
 *  make an arrow press look like a no-op. */
export function moveRibbonItem(id: RibbonItemId, delta: -1 | 1): void {
  const cur = read();
  const hidden = new Set(cur.hidden);
  const from = cur.order.indexOf(id);
  if (from < 0) return;
  let to = from + delta;
  while (to >= 0 && to < cur.order.length) {
    const other = cur.order[to];
    if (other !== undefined && !hidden.has(other)) break;
    to += delta;
  }
  const other = cur.order[to];
  if (to < 0 || to >= cur.order.length || other === undefined) return;
  const order = [...cur.order];
  order[from] = other;
  order[to] = id;
  write({ ...cur, order });
}

/** Reset to the canonical order with every destination shown. */
export function resetRibbonLayout(): void {
  write(repair([], []));
}

/** The live ribbon layout. */
export function useRibbonLayout(): RibbonLayout {
  const [v, setV] = useState<RibbonLayout>(read);
  useEffect(() => {
    const l = () => setV(read());
    listeners.add(l);
    window.addEventListener("storage", l);
    return () => {
      listeners.delete(l);
      window.removeEventListener("storage", l);
    };
  }, []);
  return v;
}
