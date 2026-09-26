// Bottom-bar item display-order helpers (MYND bottom-bar reorder). Pure
// functions that resolve the user's stored `bar_items_order` prefs sequence
// against the canonical default and compute reorder results for the two
// gestures (drag-to-reorder + the right-click "move left / move right"
// a11y fallback). Persisted via `setBarItemsOrder` (src/lib/prefs.ts).
//
// The order covers the RIGHT cluster only — the far-left of the bar (before the
// spacer) holds no reorderable item. The `preview-companion-toggle` is a
// contextual affordance, not a `BAR_ITEMS` id, and is pinned outside this order
// entirely.

/**
 * Canonical default display order of the right-cluster bottom-bar items —
 * matches the pre-reorder render order so a vault that never reordered its bar
 * (empty `bar_items_order`) looks byte-for-byte identical after this feature
 * lands. Adding a new right-cluster item means appending its id here (a known
 * id absent from a user's stored order falls back to its position here).
 */
/**
 * The toggleable bottom-bar items: id plus the i18n key for its label.
 *
 * ONE roster, read by three surfaces now (myne-md/myne#773): the `BottomBar`
 * gates each element's render on `!hiddenItems.includes(id)`, the bar's
 * right-click menu maps over it to build its checkable items, and
 * Settings -> Appearance's bar-customization block does the same. It used to be
 * a `const` private to `Editor.tsx`, which was fine while the only two readers
 * lived in that file and stops being fine the moment a third one exists
 * anywhere else.
 *
 * Ids are a closed, non-secret UI vocabulary persisted in
 * `vault.prefs.hidden_bar_items`. The ORDER here is menu order; display order
 * is {@link RIGHT_CLUSTER_DEFAULT_ORDER} resolved against the user's stored
 * sequence, which is a different question and deliberately a different list.
 */
export const BAR_ITEMS: ReadonlyArray<{ id: string; labelKey: string }> = [
  { id: "save-status", labelKey: "editor.chrome.barItems.saveStatus" },
  { id: "view-mode", labelKey: "editor.chrome.barItems.viewMode" },
  { id: "workspace", labelKey: "editor.chrome.barItems.workspace" },
  { id: "tags", labelKey: "editor.chrome.barItems.tags" },
  { id: "views", labelKey: "editor.chrome.barItems.views" },
  { id: "settings", labelKey: "editor.chrome.barItems.settings" },
  { id: "lock", labelKey: "editor.chrome.barItems.lock" },
  { id: "vim-mode", labelKey: "editor.chrome.barItems.vimMode" },
  { id: "word-count", labelKey: "editor.chrome.barItems.wordCount" },
];

export const RIGHT_CLUSTER_DEFAULT_ORDER: readonly string[] = [
  "save-status",
  "workspace",
  "view-mode",
  "tags",
  "views",
  "settings",
  "lock",
  "vim-mode",
  "word-count",
];

/**
 * Resolve the effective right-cluster order from the (possibly partial / stale /
 * empty) stored sequence: keep the stored ids that are still valid (in
 * `canonical`), deduped, in stored order; then append any canonical ids the
 * stored order omitted (a fresh vault, or a right-cluster item added in a later
 * release). The result is always a permutation of `canonical`.
 */
export function resolveBarOrder(
  stored: readonly string[],
  canonical: readonly string[] = RIGHT_CLUSTER_DEFAULT_ORDER,
): string[] {
  const known = new Set(canonical);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of stored) {
    if (known.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  for (const id of canonical) {
    if (!seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  return out;
}

/**
 * Compute a new order by moving `dragged` to just before / after `target`
 * (the drag-to-reorder drop). Returns a fresh array; a no-op (same id, or a
 * target not present) returns the input order's elements unchanged.
 */
export function reorderByDrop(
  order: readonly string[],
  dragged: string,
  target: string,
  edge: "before" | "after",
): string[] {
  if (dragged === target) return [...order];
  const without = order.filter((id) => id !== dragged);
  const targetIdx = without.indexOf(target);
  if (targetIdx < 0) return [...order];
  const insertAt = edge === "before" ? targetIdx : targetIdx + 1;
  without.splice(insertAt, 0, dragged);
  return without;
}

/**
 * Whether `id` can move one step in `dir` (`-1` = left/earlier, `1` =
 * right/later) among the currently VISIBLE items. False at the visible-sequence
 * boundary (or when `id` is not visible) — the caller omits the corresponding
 * "move" menu action (the flat ContextMenu has no disabled state).
 */
export function canMoveBarItem(
  visibleIds: readonly string[],
  id: string,
  dir: -1 | 1,
): boolean {
  const i = visibleIds.indexOf(id);
  if (i < 0) return false;
  const j = i + dir;
  return j >= 0 && j < visibleIds.length;
}

/**
 * Move `id` one step in `dir` relative to its nearest VISIBLE neighbour, and
 * return the new FULL order (hidden items keep their stored slots). Operating on
 * the visible sequence keeps the gesture intuitive even when a hidden item sits
 * between two visible ones. A boundary move (see {@link canMoveBarItem}) returns
 * the order unchanged. Reuses {@link reorderByDrop} for the splice.
 */
export function moveBarItem(
  order: readonly string[],
  visibleIds: readonly string[],
  id: string,
  dir: -1 | 1,
): string[] {
  if (!canMoveBarItem(visibleIds, id, dir)) return [...order];
  const i = visibleIds.indexOf(id);
  const neighbour = visibleIds[i + dir]!;
  // Drop `id` on the far side of the neighbour so it lands past it.
  return reorderByDrop(order, id, neighbour, dir === -1 ? "before" : "after");
}
