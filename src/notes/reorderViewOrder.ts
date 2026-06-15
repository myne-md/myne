// `reorderViewOrder` — pure helper for moving a saved view within the display
// order (Saved Views #4, MYND-274, task 6). The result feeds `setViewOrder`,
// which persists the `view_order` sequence in `vault.prefs` (verbatim, NFC,
// no sort/dedup — the `item_order`/`favorites` discipline; #3's field).
//
// Move is the testable reorder seam (the context-menu "Move up/down"). It
// operates on the current DISPLAY order (`view_order` resolved + any unordered
// views appended), so the returned array is the full, explicit new sequence.

/**
 * Move `id` one slot in `dir` (`-1` = up/earlier, `1` = down/later) within the
 * ordered id list. Returns a NEW array; a no-op (id absent, or already at the
 * boundary) returns the input order unchanged (same elements, fresh array). No
 * sort, no dedup — order is the payload.
 */
export function moveInOrder(
  ids: readonly string[],
  id: string,
  dir: -1 | 1,
): string[] {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return [...ids];
  const next = [...ids];
  const tmp = next[i]!;
  next[i] = next[j]!;
  next[j] = tmp;
  return next;
}
