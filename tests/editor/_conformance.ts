// Shared markdown render-conformance harness (MYND-208, sub-feature
// render-conformance-harness; the SYNC-1 contract).
//
// The single mount/assert surface every sibling sub-feature of the
// `markdown-render-conformance` epic reuses. Unlike the per-file `mount`
// helpers (which compose a decoration subset), this mounts the FULL composed
// editor (`myneExtensions()`) into a jsdom host, so render and byte round-trip
// are asserted against the production decoration pipeline — the only way to
// catch an extension that mutates the buffer or a cross-decoration collision.
//
// Test files that import this MUST declare `// @vitest-environment jsdom`.

import { assertParsed } from "./_parse-budget";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { myneExtensions } from "../../src/editor/extensions";
import {
  type CatalogRow,
  setCatalogLoader,
} from "../../src/editor/attachments/catalog";
import { setEmojiLoader } from "../../src/editor/decorations/emoji";
import { setSanitizerLoader } from "../../src/editor/html/sanitize";
import { setMathRendererLoader } from "../../src/editor/math/render-math";
import { setMermaidLoader } from "../../src/editor/mermaid/render-mermaid";

// The emoji shortcode map lazy-loads via a dynamic import + async dispatch (same
// race class as the catalog). Stub it to never resolve so conformance mounts are
// deterministic; the dedicated emoji test dispatches the map directly.
setEmojiLoader(() => new Promise<Readonly<Record<string, string>>>(() => {}));

// Same for the embedded-HTML DOMPurify loader: never resolve, so embedded HTML
// stays plain text in conformance mounts (the @scope:deferred-embedded-html
// case asserts that). The dedicated embedded-html test dispatches a purifier.
setSanitizerLoader(() => new Promise<never>(() => {}));

// Same for the KaTeX math renderer: never resolve, so `$…$`/`$$…$$` stay literal
// in conformance mounts (@scope:deferred-math-katex). The math test dispatches a
// renderer directly.
setMathRendererLoader(() => new Promise<never>(() => {}));

// Same for the Mermaid renderer loader: never resolve, so ```mermaid blocks stay
// raw in conformance mounts. The dedicated mermaid test dispatches a renderer.
setMermaidLoader(() => new Promise<never>(() => {}));

// The attachment catalog loads via a Tauri IPC on mount; that IPC doesn't exist
// in jsdom. Override it with a loader that NEVER resolves: the real loader
// dispatches a StateEffect from an async `.then()`, which can land mid-update in
// jsdom and throw "Calls to EditorView.update are not allowed while an update is
// in progress". tests.md has no attachments, so a perpetually-"loading" catalog
// is invisible — and never dispatching removes the race entirely.
setCatalogLoader(() => new Promise<ReadonlyMap<string, CatalogRow>>(() => {}));

export interface Mounted {
  readonly view: EditorView;
  readonly host: HTMLElement;
}

/** Parse the WHOLE document before the mount is handed back, and FAIL BY NAME
 *  if that did not happen.
 *
 *  `mount` used to force no parse at all. An `EditorView`'s parsing is driven by
 *  a `ViewPlugin` that schedules work asynchronously, so the tree a mount hands
 *  back is whatever that background parser had reached when the constructor
 *  returned, and nothing guarantees that is the whole document. Every decoration
 *  in this editor is built from that tree, which makes a partial parse
 *  indistinguishable from a missing decoration: the assertion fails naming a
 *  node the parser had not reached, with a message about the decoration and
 *  nothing about the parse.
 *
 *  Under `vitest run` the machine is shared with every other worker, so this is
 *  load-dependent rather than deterministic: `table-in-blockquote.test.ts`
 *  failed once in eight consecutive full-suite runs here, and passes every
 *  isolated run. That is the shape that reads as a broken test rather than as a
 *  missing parse.
 *
 *  An independent measurement from the editor-bugs branch (myne-md/myne#626),
 *  which found this helper's missing parse separately and is preserved here
 *  because it is the wider sample: roughly one full-suite run in three, moving
 *  between files rather than settling on one, seen in `list-render`'s nested
 *  ring and `taskLineEditing`'s second Enter, and always passing when the file
 *  is run alone. Only the OBSERVATION is carried over. That branch also
 *  attributed the cause to the time budget, which the paragraph below refutes by
 *  measurement.
 *
 *  Note what is NOT the cause, because the obvious reading is wrong and
 *  `_parse-budget.ts` records the measurement that refutes it: the budget is not
 *  reached at these document sizes. Setting it to 0 leaves these tests passing,
 *  since `ParseContext.work` advances a chunk before consulting its deadline and
 *  a small document finishes inside that chunk. Forcing the parse at all is the
 *  fix; the budget is only a runaway guard for a large document.
 *
 *  The throw is the other half, and it is the half that holds at every document
 *  size. `forceParsing` REPORTS whether it finished, and that result used to be
 *  discarded, so a test could proceed on a partial tree with nothing saying so.
 *  Throwing turns "this decoration is missing" into "the parse did not
 *  complete". Verified in both directions: a mounted 40 000-item list under a
 *  0 ms budget reaches this throw, and the small documents in this tree do
 *  not. */
export function forceCompleteParse(view: EditorView): void {
  assertParsed(view);
}

/** Mount the full Myne editor over `doc`, cursor parked at `selectionPos`
 *  (default: end of doc — outside every construct, so cursor-aware decorations
 *  render rather than reveal). */
export function mount(doc: string, selectionPos?: number): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const pos = selectionPos ?? doc.length;
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: pos, head: pos },
      extensions: [...myneExtensions()],
    }),
    parent: host,
  });
  forceCompleteParse(view);
  view.requestMeasure();
  return { view, host };
}

/** Focus + re-dispatch the selection so cursor-aware ViewPlugins rebuild with
 *  the live `view.hasFocus` value (jsdom `.focus()` alone doesn't fire it). */
export function focusAt(m: Mounted, pos: number): void {
  m.view.focus();
  m.view.dispatch({ selection: { anchor: pos, head: pos } });
  m.view.requestMeasure();
}

/** The visible rendered text (what the WebView shows), for DOM assertions. */
export function renderedText(m: Mounted): string {
  return m.view.contentDOM.textContent ?? "";
}

/** Query a single decoration node by CSS selector within the mounted editor. */
export function query(m: Mounted, selector: string): Element | null {
  return m.host.querySelector(selector);
}

/** Query all decoration nodes by CSS selector within the mounted editor. */
export function queryAll(m: Mounted, selector: string): Element[] {
  return Array.from(m.host.querySelectorAll(selector));
}

export function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

/**
 * Byte round-trip guard (§6 C1). Mount `doc`, run a focus cycle (cursor to
 * start, into the body, and back to end), then return the final document
 * string. Decorations are render-only, so this MUST equal the input for every
 * construct — any divergence is a C1 violation.
 */
export function roundTripBytes(doc: string): string {
  const m = mount(doc);
  try {
    focusAt(m, 0);
    focusAt(m, Math.floor(doc.length / 2));
    focusAt(m, doc.length);
    return m.view.state.doc.toString();
  } finally {
    teardown(m);
  }
}
