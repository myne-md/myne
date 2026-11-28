// One device-local "layout" store: an ordered list of ids, a set of hidden ones,
// persisted in `localStorage` and published to React.
//
// One surface needs exactly this now — the expanded-size-class rail
// (`lib/nav-ribbon.ts`). It was written twice (the rail and the home screen's
// cards) and both copies were the same read/repair/write/subscribe shape, which is
// what `check-duplication` flagged. The home board has since moved to the SYNCED
// arrangement (`prefs.home_cards`, myne-md/myne#1074), so the store has one caller
// again — kept, because the shape is still the right one for a per-device layout
// and the rule it encodes (repair rather than trust) is not obvious enough to
// re-derive a third time.
//
// It is a STORE rather than React context on purpose: both consumers render in
// the editor shell, where a preference change must reach a mounted surface with
// no remount and no provider to thread.

import { useEffect, useState } from "react";

export interface LayoutState<Id extends string> {
  /** Full order; always a permutation of the canonical list. */
  order: Id[];
  hidden: Id[];
}

export interface LayoutStore<Id extends string> {
  /** Live layout, re-rendering the caller on every change. */
  useLayout: () => LayoutState<Id>;
  setHidden: (id: Id, hidden: boolean) => void;
  /** Move one entry one slot up (-1) or down (+1), swapping with the nearest
   *  VISIBLE neighbour so a hidden entry between two shown ones cannot turn an
   *  arrow press into a no-op. */
  move: (id: Id, delta: -1 | 1) => void;
  reset: () => void;
}

/** Build a store over one `localStorage` key.
 *
 *  `canonical` is the closed vocabulary: a stored order that is missing an id
 *  (a build that added one) or names an id a later build dropped is REPAIRED on
 *  read rather than trusted, so a stale layout can never hide a destination for
 *  good. */
export function createLayoutStore<Id extends string>(key: string, canonical: readonly Id[]): LayoutStore<Id> {
  const listeners = new Set<() => void>();
  const isId = (v: unknown): v is Id => typeof v === "string" && (canonical as readonly string[]).includes(v);

  const repair = (order: unknown, hidden: unknown): LayoutState<Id> => {
    const stored = Array.isArray(order) ? order.filter(isId) : [];
    const seen = new Set<Id>();
    const repaired: Id[] = [];
    for (const id of stored) {
      if (seen.has(id)) continue;
      seen.add(id);
      repaired.push(id);
    }
    for (const id of canonical) if (!seen.has(id)) repaired.push(id);
    const hiddenIds = Array.isArray(hidden) ? hidden.filter(isId) : [];
    return { hidden: [...new Set(hiddenIds)], order: repaired };
  };

  const read = (): LayoutState<Id> => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? "{}") as { order?: unknown; hidden?: unknown };
      return repair(raw.order, raw.hidden);
    } catch {
      return repair([], []);
    }
  };

  const write = (next: LayoutState<Id>): void => {
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* private mode — the edit just will not persist */
    }
    listeners.forEach((l) => l());
  };

  return {
    useLayout: () => {
      const [v, setV] = useState<LayoutState<Id>>(read);
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
    },
    setHidden: (id, hidden) => {
      const cur = read();
      const next = hidden
        ? cur.hidden.includes(id)
          ? cur.hidden
          : [...cur.hidden, id]
        : cur.hidden.filter((x) => x !== id);
      write({ ...cur, hidden: next });
    },
    move: (id, delta) => {
      const cur = read();
      const hiddenIds = new Set(cur.hidden);
      const from = cur.order.indexOf(id);
      if (from < 0) return;
      let to = from + delta;
      while (to >= 0 && to < cur.order.length) {
        const other = cur.order[to];
        if (other !== undefined && !hiddenIds.has(other)) break;
        to += delta;
      }
      const other = cur.order[to];
      if (to < 0 || to >= cur.order.length || other === undefined) return;
      const order = [...cur.order];
      order[from] = other;
      order[to] = id;
      write({ ...cur, order });
    },
    reset: () => write(repair([], [])),
  };
}
