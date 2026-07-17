// The bridge between the persisted `FilterNode` AST (prefs / query engine) and
// the mobile view-editor's flat condition list. Mobile authors a single-level
// AND/OR of leaf conditions (tag / folder / text / property) — the common case —
// while still *running* any AST a desktop client authored (nested combinators,
// `not`) via the query engine. Parsing a richer AST here is lossy by design:
// only the leaves mobile can render survive a round-trip through the editor.

import type { FilterNode, PropertyOp } from "./prefs";

/** One editable row in the view editor. */
export type ViewCondition =
  | { type: "tag"; value: string }
  | { type: "folder"; value: string }
  | { type: "search"; value: string }
  | { type: "property"; key: string; op: PropertyOp; value: string };

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
    case "property":
      return { type: "property", key: node.key, op: node.op, value: node.value };
    default:
      return null; // and/or/not/all — not an editable leaf
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
    case "property":
      return { kind: "property", key: c.key, op: c.op, value: c.value };
  }
}

/** Whether a condition is filled in enough to serialize. A property condition
 *  needs a KEY but its value may be blank on purpose (`== ""` / `!= ""` are
 *  legitimate queries) — the same rule as the desktop `sanitizeDraft`, so the
 *  same view saves identically on both platforms. */
const isComplete = (c: ViewCondition): boolean =>
  c.type === "property" ? c.key.trim() !== "" : c.value.trim() !== "";

/** Flatten a persisted filter into the editor's condition list. Combinators
 *  other than a top-level AND/OR of leaves, and the `not` wrapper, don't
 *  round-trip — they drop out (the caller keeps running the stored AST until
 *  the user re-saves). */
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
  const leaves = draft.conditions.filter(isComplete).map(conditionToLeaf);
  if (leaves.length === 0) return { kind: "all" };
  if (leaves.length === 1) return leaves[0];
  return { kind: draft.mode, children: leaves };
}
