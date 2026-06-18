// Nested-list folding (heading-list-folding / MYND-300, task 3).
//
// Heading-SECTION folding ships for free: @codemirror/lang-markdown composes a
// `headerIndent` foldService into editor state, and mounting `codeFolding()` +
// `foldGutter()` (extensions.ts) surfaces it. The one custom piece is LIST
// folding — stock markdown's `foldNodeProp` deliberately excludes lists, so we
// add a `foldService` keyed on the lezer `ListItem` node.
//
// CHILDREN-ONLY predicate (story 3): a list item folds only when it has a
// nested sub-list (`BulletList`/`OrderedList` child) — i.e. it spans more than
// its own first line. A flat single-line item returns null, so the gutter shows
// no arrow on it (the prose-first "quiet gutter on flat lists" requirement).
//
// CM6 calls a foldService with `(state, lineStart, lineEnd)` per line and folds
// the FIRST non-null range. We anchor the fold to the item's FIRST line: the
// range collapses everything after that line through the end of the item's last
// descendant line, so folding `- parent` hides `  - child a` / `  - child b`
// but not a following sibling `- flat`.

import { foldService, syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

const LIST_CONTAINER_NAMES: ReadonlySet<string> = new Set([
  "BulletList",
  "OrderedList",
]);

/** True when `item` directly contains a nested list (so it has children). */
function hasNestedList(item: SyntaxNode): boolean {
  let child: SyntaxNode | null = item.firstChild;
  while (child !== null) {
    if (LIST_CONTAINER_NAMES.has(child.name)) return true;
    child = child.nextSibling;
  }
  return false;
}

/**
 * Compute the fold range for a list item whose first line starts at `lineStart`.
 * Returns `{ from, to }` (collapse after the first line through the item end)
 * when the item is a children-bearing `ListItem`, else null.
 */
export function listFoldRange(
  state: EditorState,
  lineStart: number,
  lineEnd: number,
): { from: number; to: number } | null {
  const tree = syntaxTree(state);
  // Resolve the innermost node at the line start, then walk UP to the ListItem
  // that begins on this line. `resolveInner(pos, 1)` biases into the node
  // starting at `pos` (e.g. the ListMark) rather than the previous node.
  let node: SyntaxNode | null = tree.resolveInner(lineStart, 1);
  let item: SyntaxNode | null = null;
  while (node !== null) {
    if (node.name === "ListItem") {
      item = node;
      break;
    }
    node = node.parent;
  }
  if (item === null) return null;
  // Only fold the item from its FIRST line — `from` must sit on this line.
  if (item.from < lineStart || item.from > lineEnd) return null;
  // Children-only: a flat single-line item is not foldable.
  if (!hasNestedList(item)) return null;
  // Collapse everything after the first line through the item's end. CM6 clamps
  // `to` to the doc end; the item's `.to` already excludes the following
  // sibling's line.
  const from = lineEnd;
  const to = item.to;
  if (to <= from) return null;
  return { from, to };
}

/** The list-fold `foldService` extension — compose into `myneExtensions()`. */
export function listFoldService(): Extension {
  return foldService.of((state, lineStart, lineEnd) =>
    listFoldRange(state, lineStart, lineEnd),
  );
}
