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
// tests still PASS: `ParseContext.work` advances at least one chunk before it
// consults its deadline, and a forty-character document finishes inside that
// first chunk. The budget is unreachable at these sizes, so raising it fixes
// nothing at these sizes.
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
// returns a boolean, `ensureSyntaxTree` returns `null` — and both call sites
// discarded that, so a test could proceed on a partial tree with nothing saying
// so. Each caller now throws. That turns "this decoration is missing" into "the
// parse did not complete", and unlike the budget it holds at every document
// size rather than only at large ones.
export const PARSE_BUDGET_MS = 30_000;
