// Auto-close fenced code blocks (MYND-154 task 5).
//
// Pressing Enter at the end of an OPENING fence line (```lang) inserts the
// matching closing ``` below and drops the cursor onto the empty body line
// between them — mirroring the `closeBrackets` affordance so the user never
// types the closer and never accidentally swallows the rest of the note into
// one block (grill Q10).
//
// Guards (so it fires ONLY on a genuine opener):
//   - cursor is a plain caret at the END of the line;
//   - the line matches an opening-fence shape (indent + >=3 backticks + an info
//     string with no further backticks) — excludes inline code and mid-line ```;
//   - the enclosing FencedCode is UNCLOSED (< 2 CodeMark) — so typing ``` to
//     CLOSE an existing block does not insert a second closer;
//   - this line is the FencedCode's opening line — so a non-closing ``` line
//     absorbed as body content of a block above does not trigger.
// Backtick auto-pairing for inline code stays with `closeBrackets`; this Enter
// binding is orthogonal and leaves it unaffected.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView, KeyBinding } from "@codemirror/view";

const OPENING_FENCE = /^(\s*)(`{3,})([^`]*)$/;

export interface AutoCloseFencePlan {
  readonly from: number;
  readonly insert: string;
  readonly cursor: number;
}

/**
 * Decide whether Enter on the current selection should auto-close a fence, and
 * what edit to make. Pure (state → plan|null) for unit testing.
 */
export function planAutoCloseFence(state: EditorState): AutoCloseFencePlan | null {
  const main = state.selection.main;
  if (!main.empty) return null;
  const line = state.doc.lineAt(main.head);
  if (main.head !== line.to) return null; // only at end of the line

  const m = OPENING_FENCE.exec(line.text);
  if (!m) return null;

  // The enclosing FencedCode must be unclosed AND this must be its opening line.
  const tree = syntaxTree(state);
  let fenced = tree.resolveInner(line.from, 1);
  while (fenced && fenced.name !== "FencedCode") fenced = fenced.parent!;
  if (!fenced) return null;
  if (fenced.getChildren("CodeMark").length >= 2) return null; // already closed
  if (state.doc.lineAt(fenced.from).number !== line.number) return null; // not the opener

  const fence = m[2]; // backticks of matching length
  return { from: main.head, insert: `\n\n${fence}`, cursor: main.head + 1 };
}

function autoCloseFence(view: EditorView): boolean {
  const plan = planAutoCloseFence(view.state);
  if (!plan) return false;
  view.dispatch({
    changes: { from: plan.from, insert: plan.insert },
    selection: { anchor: plan.cursor },
    userEvent: "input.complete.fence",
    scrollIntoView: true,
  });
  return true;
}

// Bind before the default Enter so an opening fence is completed instead of a
// plain newline. Returns false (falls through) on any non-opener Enter.
export const autoCloseFenceKeymap: readonly KeyBinding[] = [
  { key: "Enter", run: autoCloseFence },
];
