// `paneHistory` — pure, React-free model for per-pane back/forward
// navigation history (MYND-260).
//
// Browser-style history: each leaf pane keeps the ordered sequence of notes
// it has *shown* (its `activeTab` over time) plus a cursor into that
// sequence. Going back/forward moves the cursor; visiting a fresh note from
// anywhere but a back/forward step truncates the forward tail and appends.
//
// Deliberately NOT part of `WorkspaceState`: this is ephemeral browsing
// state that must never be serialized into `vault.workspace` — that blob is
// kept a low-resolution lock/quit signal, not a per-note browsing log
// (design grill 2026-06-01 Q1, `workspace-persist.ts`). The React Context
// (`workspaceContext`) holds a `Map<PaneId, PaneHistory>` next to — not
// inside — the persisted pane tree and folds each pane's live `activeTab`
// into it via {@link reconcileHistories}.

import type { LeafPane, PaneId, WorkspaceItem } from "./workspaceState";
import { sameItem } from "./workspaceState";

/**
 * One pane's navigation history. `entries[index]` is the item (note or view)
 * currently shown; `index` is `-1` only when `entries` is empty (a pane that
 * has never shown an item). View tabs are recorded as ordinary visits
 * alongside notes (MYND-274 — history treats a view tab like any other).
 */
export type PaneHistory = {
  entries: WorkspaceItem[];
  index: number;
};

/** A pane that has shown nothing yet. Shared, never mutated. */
export const EMPTY_HISTORY: PaneHistory = { entries: [], index: -1 };

/**
 * A back/forward step in flight: the {@link reconcileHistories} pass treats a
 * matching pane's next `activeTab` change as a cursor MOVE to `targetIndex`
 * rather than a fresh visit. Set by the chrome's back/forward action just
 * before it re-activates the target note. `null` when the next change is an
 * ordinary navigation.
 */
export type NavIntent = { paneId: PaneId; targetIndex: number } | null;

/** Whether a "back" step is available from `h`. */
export function canStepBack(h: PaneHistory | undefined): boolean {
  return h !== undefined && h.index > 0;
}

/** Whether a "forward" step is available from `h`. */
export function canStepForward(h: PaneHistory | undefined): boolean {
  return h !== undefined && h.index >= 0 && h.index < h.entries.length - 1;
}

/**
 * Record a visit to `item`: a no-op when it is already the current entry
 * (re-asserting the same item never grows history); otherwise the forward
 * tail is dropped and `item` appended as the new current entry.
 */
export function recordVisit(h: PaneHistory, item: WorkspaceItem): PaneHistory {
  if (h.index >= 0 && sameItem(h.entries[h.index]!, item)) return h;
  const entries = h.entries.slice(0, h.index + 1);
  entries.push(item);
  return { entries, index: entries.length - 1 };
}

/**
 * Fold every live pane's current `activeTab` into its history and prune
 * histories of panes that no longer exist. Returns `prev` unchanged (same
 * reference) when nothing moved, so the caller can skip a re-render.
 *
 *  - A pane whose `activeTab` is `null` (empty / new-tab chooser) is left
 *    untouched — its cursor still points at the last note it showed.
 *  - When `intent` names a pane and its new `activeTab` matches
 *    `entries[targetIndex]`, that is consumed as a cursor MOVE (back/forward).
 *  - Any other changed `activeTab` is a fresh {@link recordVisit}.
 */
export function reconcileHistories(
  prev: ReadonlyMap<PaneId, PaneHistory>,
  leaves: readonly LeafPane[],
  intent: NavIntent,
): ReadonlyMap<PaneId, PaneHistory> {
  const next = new Map<PaneId, PaneHistory>();
  let changed = false;

  for (const leaf of leaves) {
    const cur = prev.get(leaf.id) ?? EMPTY_HISTORY;
    const active = leaf.activeTab;
    let updated = cur;

    if (active !== null) {
      const moving =
        intent !== null &&
        intent.paneId === leaf.id &&
        intent.targetIndex >= 0 &&
        intent.targetIndex < cur.entries.length &&
        sameItem(cur.entries[intent.targetIndex]!, active);

      if (moving) {
        updated =
          cur.index === intent!.targetIndex
            ? cur
            : { entries: cur.entries, index: intent!.targetIndex };
      } else if (cur.index >= 0 && sameItem(cur.entries[cur.index]!, active)) {
        updated = cur; // already the current entry — nothing to do
      } else {
        updated = recordVisit(cur, active);
      }
    }

    if (updated !== cur) changed = true;
    // Only retain a meaningful (non-empty) history; an untouched empty pane
    // need not occupy a map slot (an absent key reads as EMPTY downstream).
    if (updated.entries.length > 0) next.set(leaf.id, updated);
  }

  // A pane that vanished (closed / merged) whose history we were holding is a
  // change even if no surviving pane moved.
  if (!changed) {
    for (const id of prev.keys()) {
      if (!next.has(id)) {
        changed = true;
        break;
      }
    }
  }

  return changed ? next : prev;
}
