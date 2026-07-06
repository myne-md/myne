// The bridge between the persisted `FilterNode` AST (prefs / query engine) and
// the mobile view-editor's flat condition list. Mobile authors a single-level
// AND/OR of leaf conditions (tag / folder / text) — the common case — while
// still *running* any AST a desktop client authored (nested combinators, `not`,
// `property`) via the query engine. Parsing a richer AST here is lossy by design:
// only the leaves mobile can render survive a round-trip through the editor.

import type { FilterNode } from "./prefs";

/** One editable row in the view editor. */
export type ViewCondition =
  | { type: "tag"; value: string }
  | { type: "folder"; value: string }
  | { type: "search"; value: string };

/** The flat, editor-facing shape of a view's filter. */
export interface ViewDraft {
  mode: "and" | "or";
  conditions: ViewCondition[];
}

function leafToCondition(node: FilterNode): ViewCondition | null {
  switch (node.kind) {
    case "hasTag":
      return { type: "tag", value: node.tag };
    case "inFolder":
      return { type: "folder", value: node.path };
    case "search":
      return { type: "search", value: node.query };
    default:
      return null; // and/or/not/property/all — not an editable leaf
  }
}

function conditionToLeaf(c: ViewCondition): FilterNode {
  switch (c.type) {
    case "tag":
      return { kind: "hasTag", tag: c.value };
    case "folder":
      return { kind: "inFolder", path: c.value };
    case "search":
      return { kind: "search", query: c.value };
  }
}

/** Flatten a persisted filter into the editor's condition list. Combinators
 *  other than a top-level AND/OR of leaves, and the `not`/`property` leaves,
 *  don't round-trip — they drop out (the caller keeps running the stored AST
 *  until the user re-saves). */
export function parseFilters(node: FilterNode): ViewDraft {
  if (node.kind === "and" || node.kind === "or") {
    const conditions = node.children.map(leafToCondition).filter((c): c is ViewCondition => c !== null);
    return { mode: node.kind, conditions };
  }
  const leaf = leafToCondition(node);
  return { mode: "and", conditions: leaf ? [leaf] : [] };
}

/** Build a persisted filter from the editor's condition list. Empty → `all`;
 *  one condition → the bare leaf (no needless wrapper); many → an AND/OR node.
 *  Byte-compatible with the desktop `FilterNode`. */
export function buildFilters(draft: ViewDraft): FilterNode {
  const leaves = draft.conditions
    .filter((c) => c.value.trim() !== "")
    .map(conditionToLeaf);
  if (leaves.length === 0) return { kind: "all" };
  if (leaves.length === 1) return leaves[0];
  return { kind: draft.mode, children: leaves };
}
