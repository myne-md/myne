// `filterDraft` — the filter builder's pure, UI-agnostic core (Saved Views #4,
// MYND-282, task 1). Converts between the canonical `FilterNode` AST persisted in
// `vault.prefs` and the builder's editable "single-level groups" draft model, and
// classifies whether a given AST can be faithfully edited by the builder.
//
// The draft is a Notion/Airtable-style shape: a top-level All/Any combinator over
// a list of GROUPS, each group its own All/Any combinator over a list of
// CONDITIONS. This maps to AT MOST a 2-level `and`/`or` AST — the representable
// set. A condition is one leaf: tag / folder / search with an optional
// per-condition negation (`is not`), or a property comparison (key + op + value;
// no negation row — the `!=` operator covers it, so `not(property)` stays
// OUTSIDE the representable set). Anything else (a negated group, nesting deeper
// than 2 levels, `not` over a property) must fail safe (read-only + Replace),
// never silently drop conditions. That guarantee lives here: `filterNodeToDraft`
// returns `null` for anything outside the representable set, and
// `isRepresentable` is the classifier the UI reads. No IPC, no React — this is
// the testable foundation.

import type { FilterNode, PropertyOp } from "../lib/prefs";

/** The plain condition leaf kinds that carry an `is / is not` negation. */
export type PlainConditionType = "tag" | "folder" | "search";

/** The condition leaf kinds the builder can edit. */
export type ConditionType = PlainConditionType | "property";

/** One editable condition. Plain leaves carry a single `value` payload (tag key /
 *  folder path / search query) plus an `is not` negation; the property variant
 *  carries the comparison triple and deliberately has NO `negated` field — its
 *  `op` set includes `!=`, and the absence of the field is what forces
 *  `conditionFromNode` to keep `not(property)` unrepresentable. */
export type DraftCondition =
  | { type: PlainConditionType; value: string; negated: boolean }
  | { type: "property"; key: string; op: PropertyOp; value: string };

/** A group of conditions combined by All (`and`) / Any (`or`). */
export interface DraftGroup {
  combinator: "and" | "or";
  conditions: DraftCondition[];
}

/** The whole filter draft: a top-level combinator across groups (one level of
 *  nesting). An empty `groups` is the all-pages filter. */
export interface FilterDraft {
  combinator: "and" | "or";
  groups: DraftGroup[];
}

/** Build the AST leaf for one condition, wrapping in `not` when negated.
 *  Property conditions are never `not`-wrapped (negation lives in the op set). */
function leafFromCondition(c: DraftCondition): FilterNode {
  if (c.type === "property") {
    return { kind: "property", key: c.key, op: c.op, value: c.value };
  }
  let leaf: FilterNode;
  switch (c.type) {
    case "tag":
      leaf = { kind: "hasTag", tag: c.value };
      break;
    case "folder":
      leaf = { kind: "inFolder", path: c.value };
      break;
    case "search":
      leaf = { kind: "search", query: c.value };
      break;
  }
  return c.negated ? { kind: "not", child: leaf } : leaf;
}

/** Collapse one group to a node: empty → null (caller drops it), single
 *  condition → the bare leaf, else → an `and`/`or` over the leaves. */
function groupToNode(g: DraftGroup): FilterNode | null {
  const leaves = g.conditions.map(leafFromCondition);
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0]!;
  return { kind: g.combinator, children: leaves };
}

/**
 * Serialize a draft to the canonical `FilterNode`. Empty groups are dropped; a
 * single surviving group collapses to its own node (no redundant top wrapper);
 * no groups at all yields the degenerate `{ kind: "all" }`.
 */
export function draftToFilterNode(draft: FilterDraft): FilterNode {
  const groupNodes = draft.groups
    .map(groupToNode)
    .filter((n): n is FilterNode => n !== null);
  if (groupNodes.length === 0) return { kind: "all" };
  if (groupNodes.length === 1) return groupNodes[0]!;
  return { kind: draft.combinator, children: groupNodes };
}

/** Parse a bare leaf into a (non-negated) condition, or null if it isn't one of
 *  the representable leaves (`all` / combinators → null). */
function plainConditionFromLeaf(node: FilterNode): DraftCondition | null {
  switch (node.kind) {
    case "hasTag":
      return { type: "tag", value: node.tag, negated: false };
    case "inFolder":
      return { type: "folder", value: node.path, negated: false };
    case "search":
      return { type: "search", value: node.query, negated: false };
    case "property":
      return { type: "property", key: node.key, op: node.op, value: node.value };
    default:
      return null;
  }
}

/** Parse a leaf or a `not`-wrapped leaf into a condition (null if not a
 *  representable leaf; a `not` over a non-leaf is null → unrepresentable).
 *  `not(property)` is deliberately unrepresentable: the property row has no
 *  negation control (`!=` covers it), so re-serializing would drop the `not`. */
function conditionFromNode(node: FilterNode): DraftCondition | null {
  if (node.kind === "not") {
    const inner = plainConditionFromLeaf(node.child);
    return inner && inner.type !== "property" ? { ...inner, negated: true } : null;
  }
  return plainConditionFromLeaf(node);
}

/** Parse a node that should be a flat group of condition leaves into a group, or
 *  null if any child isn't a representable (optionally negated) leaf. */
function flatGroupFromNode(node: FilterNode): DraftGroup | null {
  if (node.kind !== "and" && node.kind !== "or") return null;
  const conditions: DraftCondition[] = [];
  for (const child of node.children) {
    const c = conditionFromNode(child);
    if (!c) return null;
    conditions.push(c);
  }
  return { combinator: node.kind, conditions };
}

/**
 * Parse a `FilterNode` into a draft, or `null` when the AST is outside the
 * builder's representable set (a negated group, a `not` over a property,
 * nesting deeper than 2 levels). The representable shapes are: `all`, a single
 * (optionally negated) leaf, a flat `and`/`or` of leaves (the Tags "Save as
 * view" output), and a 2-level group AST. `null` is the fail-safe signal the UI
 * reads to go read-only rather than silently dropping conditions on save.
 */
export function filterNodeToDraft(node: FilterNode): FilterDraft | null {
  if (node.kind === "all") return { combinator: "and", groups: [] };

  // A single (optionally negated) leaf → one group, one condition.
  const single = conditionFromNode(node);
  if (single) {
    return { combinator: "and", groups: [{ combinator: "and", conditions: [single] }] };
  }

  if (node.kind === "and" || node.kind === "or") {
    // Flat: every child is a condition leaf → one group (canonical for the Tags
    // shape, and the representation `draftToFilterNode` reproduces exactly).
    const flat = flatGroupFromNode(node);
    if (flat) return { combinator: "and", groups: [flat] };

    // 2-level: each child is either a bare condition leaf (→ a single-condition
    // group) or a flat group of leaves. Anything else → unrepresentable.
    const groups: DraftGroup[] = [];
    for (const child of node.children) {
      const c = conditionFromNode(child);
      if (c) {
        groups.push({ combinator: "and", conditions: [c] });
        continue;
      }
      const group = flatGroupFromNode(child);
      if (group) {
        groups.push(group);
        continue;
      }
      return null;
    }
    return { combinator: node.kind, groups };
  }

  // `not` over a non-leaf (or over a property) → unrepresentable.
  return null;
}

/** Whether the builder can faithfully edit this AST. The fail-safe classifier
 *  the UI reads: `false` → render read-only + offer "Replace filter". */
export function isRepresentable(node: FilterNode): boolean {
  return filterNodeToDraft(node) !== null;
}

/** Whether a condition is filled in enough to serialize. Plain leaves need a
 *  value; a property condition needs a KEY but its value may be blank on
 *  purpose (`== ""` matches an empty stored string, `!= ""` means "has a
 *  non-empty value" — both legitimate queries). */
const isComplete = (c: DraftCondition): boolean =>
  c.type === "property" ? c.key.trim() !== "" : c.value.trim() !== "";

/**
 * Strip incomplete conditions (blank value; for property rows, blank key) and
 * the empty groups they leave behind, so a half-filled row never serializes to
 * a `hasTag: ""` leaf. Used before both the live-count evaluation and the
 * persisted save (an all-blank draft sanitizes to `{ groups: [] }` →
 * `{ kind: "all" }`).
 */
export function sanitizeDraft(draft: FilterDraft): FilterDraft {
  const groups = draft.groups
    .map((g) => ({
      ...g,
      conditions: g.conditions.filter(isComplete),
    }))
    .filter((g) => g.conditions.length > 0);
  return { combinator: draft.combinator, groups };
}
