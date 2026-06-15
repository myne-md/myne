// `savedViewFromFilter` — build a `SavedView` from the tag-browser's active
// filter selection (Saved Views #4, MYND-274, task 5 "Save current filter as
// view"). Pure dispatch seam: the TagBrowser reads its local `selected` tag
// keys + AND/OR `mode`, this turns them into the canonical filter AST, and the
// caller persists via `upsertSavedView` (#3's API). No IPC here.

import type { FilterMode } from "./tagFilter";
import type { FilterNode, SavedView } from "../lib/prefs";

/**
 * Build a `SavedView` from a set of selected tag keys + an AND/OR mode. Each
 * selected tag becomes a `hasTag` leaf; a single tag is that leaf directly, two
 * or more are combined under an `and`/`or` node (matching the engine's
 * `combineTagSets` semantics). An empty selection yields an `all` filter (the
 * caller normally guards on a non-empty selection). The view defaults to the
 * `cards` type; the name is the user's (a blank name falls back to a tag-derived
 * label). `id` is injected (a UUID at the call site) so this stays pure/testable.
 */
export function buildViewFromTags(
  id: string,
  selectedKeys: readonly string[],
  mode: FilterMode,
  name: string,
): SavedView {
  const leaves: FilterNode[] = selectedKeys.map((tag) => ({
    kind: "hasTag",
    tag,
  }));
  let filters: FilterNode;
  if (leaves.length === 0) {
    filters = { kind: "all" };
  } else if (leaves.length === 1) {
    filters = leaves[0]!;
  } else {
    filters = { kind: mode, children: leaves };
  }
  const trimmed = name.trim();
  return {
    id,
    name: trimmed === "" ? defaultFilterViewName(selectedKeys) : trimmed,
    view_type: "cards",
    filters,
  };
}

/** A sensible default view name from the selected tags (used when the user
 *  leaves the name blank): the joined tags, or "Filtered view" when empty. */
export function defaultFilterViewName(selectedKeys: readonly string[]): string {
  return selectedKeys.length === 0 ? "Filtered view" : selectedKeys.join(", ");
}
