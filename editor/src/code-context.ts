// Shared "is the selection inside code?" predicate (MYND-154 task 7).
//
// Markdown-formatting affordances (the selection toolbar's B/I/S/code/link, and
// the `toggleWrap` keyboard commands) must be inert inside code — wrapping a
// code selection in `**`/`*`/`~~` would inject literal markers into the user's
// source. The slash menu already suppresses inside code via its own node-name
// set; this is the equivalent guard for the formatting surface.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

const CODE_NODES = new Set(["FencedCode", "CodeBlock", "InlineCode"]);

/**
 * True if any selection range sits inside a code node — a fenced block, an
 * indented code block, or inline code. Walks ancestors from the range start.
 */
export function isSelectionInCode(state: EditorState): boolean {
  const tree = syntaxTree(state);
  for (const range of state.selection.ranges) {
    let node: SyntaxNode | null = tree.resolveInner(range.from, 1);
    for (; node; node = node.parent) {
      if (CODE_NODES.has(node.name)) return true;
    }
  }
  return false;
}
