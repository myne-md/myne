// A one-shot request to open the graph pane on a particular view
// (myne-md/myne#727).
//
// The graph pane's filter is LOCAL state, a reading mode for this sitting,
// deliberately neither vault content nor workspace state, so nothing about it
// syncs and nothing about it is written to disk. That is the right home for it,
// and it is also why a command-palette action cannot set it: the command runs
// against the workspace context, and the pane it wants may not even be mounted
// yet.
//
// So the command hands the pane a REQUEST rather than a value. Same shape as
// `closeActiveTabSignal.ts` (a module-scope pending slot plus a subscribe),
// which exists for the same reason one layer down: the ex-command table lives
// inside the shared editor package with no route into the workspace context.
//
// The pending slot is what makes the two orderings both work, and it is the
// whole reason this is not just a listener set: `openGraph()` followed by a
// request reaches nobody if the pane mounts a tick later, so the request waits
// in `pending` and the pane's mount consumes it. A request that DOES land on a
// mounted pane is consumed by the listener instead, which clears the slot so the
// pane never applies it twice.

/** The graph pane's filter. Lives here rather than in the component so the
 *  request channel and the pane cannot drift about what a filter is. */
export type GraphViewFilter =
  | { kind: "all" }
  | { kind: "orphans" }
  | { kind: "tag"; key: string }
  // local-graph (#5): the note-relative entry mode, centered on `seed`, the
  // open note's 1-2 hop neighborhood. Pivot re-points `seed`; double-click navigates.
  | { kind: "local"; seed: string; depth: 1 | 2 };

let pending: GraphViewFilter | null = null;
const listeners = new Set<() => void>();

/** Ask the graph pane to show `filter`, opening on it if the pane is not up
 *  yet. The request is consumed exactly once. */
export function requestGraphViewFilter(filter: GraphViewFilter): void {
  pending = filter;
  for (const listener of [...listeners]) listener();
}

/** Take the pending request, if any, and clear it. */
export function consumeGraphViewFilter(): GraphViewFilter | null {
  const filter = pending;
  pending = null;
  return filter;
}

/** Subscribe to requests. Returns the unsubscribe. */
export function subscribeGraphViewFilter(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
