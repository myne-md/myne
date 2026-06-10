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
