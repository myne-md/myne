// The saved-view display order, in ONE place (view-manifests task 7).
//
// `vault.prefs` keeps the views themselves id-sorted and the display order in a
// separate `view_order` sequence, so every surface that lists them has to join
// the two. The sidebar already did that join inline; the Views manager needs the
// same answer, and a second copy of "walk the order, then append the leftovers"
// is a second answer waiting to disagree (a view that exists but is missing from
// `view_order` has to appear somewhere, and the two copies would disagree on
// where).

import type { SavedView } from "../../lib/prefs";

/** Views in `view_order`, followed by any view the order does not name (in
 *  storage order). A stale id in the order is skipped rather than rendered. */
export function orderSavedViews(
  views: readonly SavedView[],
  order: readonly string[],
): SavedView[] {
  const byId = new Map(views.map((view) => [view.id, view]));
  const ordered: SavedView[] = [];
  for (const id of order) {
    const view = byId.get(id);
    if (view !== undefined) {
      ordered.push(view);
      byId.delete(id);
    }
  }
  for (const view of views) {
    if (byId.has(view.id)) ordered.push(view);
  }
  return ordered;
}
