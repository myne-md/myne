// The syntax-parse budget shared by the editor tests that must observe a
// COMPLETE lezer tree, and the reason there is a constant here at all.
//
// This module is deliberately DOM-free. Its two consumers do not share an
// environment: `_conformance.ts` mounts a real `EditorView` and so requires
// `// @vitest-environment jsdom`, while `list-fold.test.ts` builds a bare
// `EditorState` and runs under node. Putting the number in `_conformance.ts`
// would drag its module-scope DOM setup — `document.createElement`, the emoji,
// mermaid and attachment-catalog loader overrides — into a headless test that
// needs none of it, purely to read one integer. Keeping a second copy of the
// integer instead is the drift this repository has a guard for everywhere else
// it occurs.
//
// WHAT THE BUDGET IS, AND WHAT IT IS NOT
//
// CodeMirror parses incrementally, so `syntaxTree(state)` returns whatever was
// finished when parsing stopped. Every decoration in this editor is built from
// that tree, which makes a partial parse indistinguishable from a missing
// decoration: the assertion fails naming a node the parser had not reached.
//
// It is natural to read the budget as the thing that goes wrong under load. It
// is NOT, at the document sizes in this tree, and the measurement that says so
// is recorded here because it refutes the obvious theory. Set this constant to
// 0, run `list-fold.test.ts` and `table-in-blockquote.test.ts`, and all ten
// tests still PASS: `ParseContext.work` returns early through its `isDone`
// check whenever the tree the context already holds covers the document, so for
// those documents it never consults a deadline at all. Do not read that as a
// property of the SIZES, which is the mistake this paragraph exists to correct:
// the deadline is consulted between BLOCKS, and measured with the clock spent, a
// 46-character paragraph-then-list-item document comes back with a tree covering
// 24 characters, because the first pass resolves only the first block. The
// budget is unreachable at these sizes, so raising it fixes nothing at these
// sizes.
//
// What the budget does bound is a LARGE document, and that bound is real: a
// mounted 40 000-item list under a 0 ms budget does stop early, and it does
// reach the throw. 30 000 ms is headroom for that case under machine load. It
// costs nothing on a healthy run — every document in `list-fold.test.ts` was
// measured parsing in 0 ms — and it is a runaway guard, not a performance
// target.
//
// THE HALF THAT ACTUALLY CARRIES THE FIX
//
// Both CodeMirror entry points REPORT whether they finished — `forceParsing`
// returns a boolean, `ensureSyntaxTree` returns `null` — and a caller that
// discards that report silently proceeds on a partial tree. That is myne#567's
// failure class in miniature: an assertion against a node the parser had not
// reached fails on a well-formed document, only under load, only in the full
// suite. The helpers below throw instead, so an incomplete parse is a loud,
// named test-harness defect rather than a flaky assertion in a random file.
//
// Use `assertParsed(view)` after mounting and `assertParsedState(state)` for a
// bare state. Do NOT call `forceParsing`/`ensureSyntaxTree` directly from a
// test: every pre-existing direct call site in this tree was found discarding
// the result, and that is how the class recurs.
import { ensureSyntaxTree, forceParsing, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export const PARSE_BUDGET_MS = 30_000;

/** Throw unless the view's syntax tree covers the whole document. */
export function assertParsed(view: EditorView, budgetMs = PARSE_BUDGET_MS): void {
  const upto = view.state.doc.length;
  if (!forceParsing(view, upto, budgetMs)) {
    throw incompleteParseError(upto, budgetMs);
  }
}

/** Throw unless the state's syntax tree covers the whole document. */
export function assertParsedState(state: EditorState, budgetMs = PARSE_BUDGET_MS): void {
  const upto = state.doc.length;
  ensureSyntaxTree(state, upto, budgetMs);
  // `ensureSyntaxTree` returning non-null is NOT sufficient, and trusting it is
  // how this helper came to pass a truncated tree. It advances the language's
  // parse CONTEXT, but `syntaxTree()` returns `field.tree`, a snapshot taken
  // when the language state field was built. The two diverge: measured on a
  // 46,890-character document, `syntaxTree()` reports length 3003 both before
  // and after a successful `ensureSyntaxTree`, while the context tree holds the
  // whole document. So a caller that checks only the return value is told the
  // parse finished and then reads a tree covering 3 KB of 46 KB.
  //
  // Therefore the contract is checked against the tree the CALLER will read.
  // `assertParsed` above needs no such check because `forceParsing` dispatches,
  // which rebuilds the field; the state path cannot dispatch.
  if (syntaxTree(state).length < upto) {
    throw incompleteParseError(upto, budgetMs);
  }
}

/**
 * Force the field tree to cover the whole document and return the state.
 *
 * `assertParsedState` above is the TRIPWIRE: it reports a short tree. This is
 * the FIXER for a BARE state, where there is no view to dispatch through. The
 * initial parse a bare state gets is time-budgeted (`LanguageState.init`, 20 ms
 * up to 3000 chars), so under machine load even a 35-character document can come
 * back short, and a caller that only asserts then reads a partial tree. CI
 * caught exactly that on `taskRowSelection.test.ts` and `footnote.test.ts`.
 *
 * `ensureSyntaxTree` advances the parse CONTEXT; a no-op transaction then
 * rebuilds the language field from that context, which is the snapshot
 * `syntaxTree()` returns. The refreshed state is what the caller must use, hence
 * the return value. Throws (via `assertParsedState`) if the tree still does not
 * cover the document, so a genuinely unparseable input stays a named failure.
 */
export function completeState(
  state: EditorState,
  budgetMs = PARSE_BUDGET_MS,
): EditorState {
  const upto = state.doc.length;
  ensureSyntaxTree(state, upto, budgetMs);
  const refreshed = state.update({}).state;
  assertParsedState(refreshed, budgetMs);
  return refreshed;
}

function incompleteParseError(upto: number, budgetMs: number): Error {
  return new Error(
    `editor test: the syntax parse did not reach ${upto} within ` +
      `${budgetMs} ms, so the tree is PARTIAL and every tree-derived ` +
      `assertion below is unreliable. The assertion is not necessarily ` +
      `failing: the parser had not reached it (myne#567).`,
  );
}
