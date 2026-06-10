// Embedded inline HTML rendering (MYND-209, embedded-html-rendering task 2).
//
// Renders the allowlisted INLINE elements tests.md uses — `<kbd>`, `<mark>`,
// `<sub>`, `<sup>`, `<abbr title>` — by sanitizing the raw span through DOMPurify
// (SYNC-5) and rendering the sanitized output, cursor-aware (raw HTML revealed
// on-cursor). Block `<p>` / `<details>` are task 3. The DOMPurify instance is
// lazy-loaded into `purifierField`; the decoration sanitizes synchronously once
// it arrives. Render-only — bytes preserved (§6 C1).
//
// `<mark>` / `<sub>` / `<sup>` reuse the SYNC-6 `.cm-highlight` / `.cm-sub` /
// `.cm-sup` classes (the sanitized element carries the tag; theme styles it).

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  editorFocusChanged,
  editorFocusField,
  editorFocusTracker,
  isInCode,
  isInsideRange,
  linesRevealed,
} from "./cursor-aware";
import { treeChanged } from "./plugin-factory";
import { loadPurifier, type Purifier, SANITIZE_CONFIG } from "../html/sanitize";

export const setPurifier = StateEffect.define<Purifier>();
export const purifierField = StateField.define<Purifier | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPurifier)) return e.value;
    return value;
  },
});

const purifierLoaderPlugin = ViewPlugin.fromClass(
  class {
    private destroyed = false;
    constructor(view: EditorView) {
      void loadPurifier().then((p) => {
        if (this.destroyed) return;
        view.dispatch({ effects: setPurifier.of(p as unknown as Purifier) });
      });
    }
    destroy() {
      this.destroyed = true;
    }
  },
);

// Allowlisted INLINE elements only (block <p>/<details> = task 3). Matched as
// whole `<tag …>…</tag>` spans; the `\1` backref keeps open/close in sync.
const INLINE_HTML_RE = /<(kbd|mark|sub|sup|abbr)\b[^>]*>[\s\S]*?<\/\1>/gi;

class InlineHtmlWidget extends WidgetType {
  constructor(
    private readonly safeHtml: string,
    private readonly key: string,
  ) {
    super();
  }
  eq(other: InlineHtmlWidget): boolean {
    return other.key === this.key;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-embedded-html";
    // innerHTML of DOMPurify-sanitized output ONLY (SYNC-5) — never raw note HTML.
    span.innerHTML = this.safeHtml;
    return span;
  }
}

function buildInlineHtml(view: EditorView): DecorationSet {
  const purifier = view.state.field(purifierField, false) ?? null;
  if (purifier === null) return Decoration.none;

  const decorations: Array<Range<Decoration>> = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    INLINE_HTML_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INLINE_HTML_RE.exec(text)) !== null) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (isInsideRange(view, start, end)) continue; // reveal raw on-cursor
      if (isInCode(view.state, start)) continue; // literal inside code
      const safe = purifier.sanitize(m[0], { ...SANITIZE_CONFIG });
      if (safe === "") continue;
      decorations.push(
        Decoration.replace({ widget: new InlineHtmlWidget(safe, m[0]) }).range(
          start,
          end,
        ),
      );
    }
  }

  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => a.from - b.from);
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

const inlineHtmlPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildInlineHtml(view);
    }
    update(update: ViewUpdate) {
      const purifierChanged =
        update.startState.field(purifierField, false) !==
        update.state.field(purifierField, false);
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        purifierChanged ||
        treeChanged(update)
      ) {
        this.decorations = buildInlineHtml(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// --- Block embedded HTML (`<p>`, `<details>`) ------------------------------
//
// Block elements need a whole-line block-replace, which CM6 forbids from a
// ViewPlugin → a StateField (SYNC-7). `<details>` renders natively interactive;
// its open/closed state lives in a WebView-only Map keyed by source (never the
// buffer, so C1 holds regardless of toggle state).

const BLOCK_HTML_RE = /<(p|details)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Ephemeral `<details>` open state, keyed by source HTML. WebView-only —
 *  never persisted, never written to the note buffer. */
const detailsOpenState = new Map<string, boolean>();

class BlockHtmlWidget extends WidgetType {
  constructor(
    private readonly safeHtml: string,
    private readonly key: string,
  ) {
    super();
  }
  eq(other: BlockHtmlWidget): boolean {
    return other.key === this.key;
  }
  toDOM(): HTMLElement {
    // Discriminator is the soft background tint (theme) — no label element.
    const div = document.createElement("div");
    div.className = "cm-embedded-html-block";
    div.innerHTML = this.safeHtml; // sanitized output ONLY (SYNC-5)
    const details = div.querySelector("details");
    if (details !== null) {
      if (detailsOpenState.get(this.key) === true) details.setAttribute("open", "");
      details.addEventListener("toggle", () => {
        detailsOpenState.set(this.key, details.open);
      });
    }
    return div;
  }
  ignoreEvent(): boolean {
    return false; // let the native <details> toggle handle clicks
  }
}

function buildBlockHtml(state: EditorState): DecorationSet {
  const purifier = state.field(purifierField, false) ?? null;
  if (purifier === null) return Decoration.none;

  const doc = state.doc;
  const text = doc.toString();
  const entries: Array<{ from: number; to: number; html: string }> = [];
  BLOCK_HTML_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_HTML_RE.exec(text)) !== null) {
    entries.push({ from: m.index, to: m.index + m[0].length, html: m[0] });
  }

  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to, html } of entries) {
    const fromLine = doc.lineAt(from);
    const toLine = doc.lineAt(to);
    if (linesRevealed(state, fromLine.number, toLine.number)) continue; // reveal raw
    if (isInCode(state, from)) continue;
    const safe = purifier.sanitize(html, { ...SANITIZE_CONFIG });
    if (safe === "") continue;
    builder.add(
      fromLine.from,
      toLine.to,
      Decoration.replace({ widget: new BlockHtmlWidget(safe, html), block: true }),
    );
  }
  return builder.finish();
}

// Bespoke StateField (not `makeCursorAwareStateField`) so the recompute gate
// ALSO fires on `setPurifier` — otherwise the block HTML wouldn't render until
// the next doc/selection change after the lazy purifier arrives.
const blockHtmlField = StateField.define<DecorationSet>({
  create(state) {
    return buildBlockHtml(state);
  },
  update(deco, tr) {
    const selectionChanged = !tr.startState.selection.eq(tr.state.selection);
    const purifierChanged = tr.effects.some((e) => e.is(setPurifier));
    const treeCh = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (
      tr.docChanged ||
      selectionChanged ||
      purifierChanged ||
      editorFocusChanged(tr) ||
      treeCh
    ) {
      return buildBlockHtml(tr.state);
    }
    return deco;
  },
  provide(f) {
    return EditorView.decorations.from(f);
  },
});

export function embeddedHtmlDecorations(): readonly Extension[] {
  return [
    purifierField,
    purifierLoaderPlugin,
    inlineHtmlPlugin,
    // editorFocusField/tracker back the `linesRevealed` read in buildBlockHtml;
    // dedup by identity if another decorator already installed them.
    editorFocusField,
    editorFocusTracker,
    blockHtmlField,
  ];
}
