// Math rendering — inline `$…$` + block `$$…$$` (MYND-48, math-katex task 3;
// invalid-LaTeX UX refined in task 4).
//
// Inline math renders over the `InlineMath` parser node; block math is found by
// a regex over the doc (block `$$…$$` is a decoration, not a parser node) and
// rendered as a whole-block widget (SYNC-7). KaTeX is lazy-loaded into
// `mathRendererField`; the decorations render once it arrives. KaTeX output
// (trust:false) is safe to `innerHTML` — vetted-output mode, SYNC-5. Render-only;
// bytes preserved (§6 C1).

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
import { loadMathRenderer, type MathRenderer } from "../math/render-math";

export const setMathRenderer = StateEffect.define<MathRenderer>();
export const mathRendererField = StateField.define<MathRenderer | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMathRenderer)) return e.value;
    return value;
  },
});

const mathLoaderPlugin = ViewPlugin.fromClass(
  class {
    private destroyed = false;
    constructor(view: EditorView) {
      void loadMathRenderer().then((r) => {
        if (this.destroyed) return;
        view.dispatch({ effects: setMathRenderer.of(r) });
      });
    }
    destroy() {
      this.destroyed = true;
    }
  },
);

/** Click-to-edit: a rendered math widget is atomic, so a plain click resolves to
 *  the block/inline boundary and never enters the source — the formula felt
 *  un-clickable. Place the cursor at the construct's source start (+ focus) so the
 *  selection touches the math, which lifts the widget and reveals the raw LaTeX. */
function attachMathClick(el: HTMLElement, view: EditorView, from: number): void {
  el.addEventListener("mousedown", (event) => {
    event.preventDefault();
    view.dispatch({ selection: { anchor: from }, userEvent: "select.pointer" });
    view.focus();
  });
}

class MathWidget extends WidgetType {
  constructor(
    private readonly html: string,
    private readonly key: string,
    private readonly block: boolean,
    private readonly from: number,
  ) {
    super();
  }
  eq(other: MathWidget): boolean {
    return other.key === this.key && other.block === this.block && other.from === this.from;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.block ? "div" : "span");
    el.className = this.block ? "cm-math-block" : "cm-math-inline";
    el.innerHTML = this.html; // KaTeX output (trust:false → no injection)
    attachMathClick(el, view, this.from);
    return el;
  }
  ignoreEvent(event: Event): boolean {
    return event.type !== "mousedown"; // own the click; ignore the rest
  }
}

/** Invalid / mid-typing LaTeX: show the raw source with a subtle failure hint
 *  (faint underline + the KaTeX message on hover) — task 4. */
class MathErrorWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly message: string,
    private readonly key: string,
    private readonly from: number,
  ) {
    super();
  }
  eq(other: MathErrorWidget): boolean {
    return other.key === this.key && other.from === this.from;
  }
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-math-error";
    span.textContent = this.source;
    span.title = this.message;
    attachMathClick(span, view, this.from);
    return span;
  }
  ignoreEvent(event: Event): boolean {
    return event.type !== "mousedown";
  }
}

function buildInlineMath(view: EditorView): DecorationSet {
  const renderer = view.state.field(mathRendererField, false) ?? null;
  if (renderer === null) return Decoration.none;

  const decorations: Array<Range<Decoration>> = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "InlineMath") return undefined;
        if (isInsideRange(view, node.from, node.to)) return undefined; // reveal
        const latex = view.state.doc.sliceString(node.from + 1, node.to - 1);
        const { html, error } = renderer(latex, false);
        const key = `i:${latex}`;
        const widget =
          error === null
            ? new MathWidget(html, key, false, node.from)
            : new MathErrorWidget(`$${latex}$`, error, key, node.from);
        decorations.push(Decoration.replace({ widget }).range(node.from, node.to));
        return undefined;
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => a.from - b.from);
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

const inlineMathPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildInlineMath(view);
    }
    update(update: ViewUpdate) {
      const rendererChanged =
        update.startState.field(mathRendererField, false) !==
        update.state.field(mathRendererField, false);
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        rendererChanged ||
        treeChanged(update)
      ) {
        this.decorations = buildInlineMath(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// Block `$$…$$` (regex; not a parser node).
const BLOCK_MATH_RE = /\$\$([\s\S]*?)\$\$/g;

// Cache the whole-doc `$$…$$` scan keyed by document identity. A pure cursor
// move keeps the SAME `Text` object (only the selection changes), so the reveal
// state can be re-evaluated without re-running the O(n) `toString()` + regex on
// every keystroke — the field still rebuilds on selection change (reveal depends
// on it), but only the cheap per-block loop runs, not the whole-doc scan.
let cachedMathDoc: EditorState["doc"] | null = null;
let cachedMathEntries: Array<{ from: number; to: number; latex: string }> = [];

function blockMathEntries(
  doc: EditorState["doc"],
): Array<{ from: number; to: number; latex: string }> {
  if (doc === cachedMathDoc) return cachedMathEntries;
  const text = doc.toString();
  const entries: Array<{ from: number; to: number; latex: string }> = [];
  BLOCK_MATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_MATH_RE.exec(text)) !== null) {
    entries.push({ from: m.index, to: m.index + m[0].length, latex: m[1] });
  }
  cachedMathDoc = doc;
  cachedMathEntries = entries;
  return entries;
}

function buildBlockMath(state: EditorState): DecorationSet {
  const renderer = state.field(mathRendererField, false) ?? null;
  if (renderer === null) return Decoration.none;

  const doc = state.doc;
  const entries = blockMathEntries(doc);

  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to, latex } of entries) {
    const fromLine = doc.lineAt(from);
    const toLine = doc.lineAt(to);
    if (linesRevealed(state, fromLine.number, toLine.number)) continue;
    if (isInCode(state, from)) continue;
    const { html, error } = renderer(latex.trim(), true);
    const key = `b:${latex}`;
    const widget =
      error === null
        ? new MathWidget(html, key, true, from)
        : new MathErrorWidget(doc.sliceString(from, to), error, key, from);
    builder.add(
      fromLine.from,
      toLine.to,
      Decoration.replace({ widget, block: true }),
    );
  }
  return builder.finish();
}

const blockMathField = StateField.define<DecorationSet>({
  create(state) {
    return buildBlockMath(state);
  },
  update(deco, tr) {
    const selectionChanged = !tr.startState.selection.eq(tr.state.selection);
    const rendererChanged = tr.effects.some((e) => e.is(setMathRenderer));
    const treeCh = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (
      tr.docChanged ||
      selectionChanged ||
      rendererChanged ||
      editorFocusChanged(tr) ||
      treeCh
    ) {
      return buildBlockMath(tr.state);
    }
    return deco;
  },
  provide(f) {
    return EditorView.decorations.from(f);
  },
});

export function mathDecorations(): readonly Extension[] {
  return [
    mathRendererField,
    mathLoaderPlugin,
    inlineMathPlugin,
    editorFocusField,
    editorFocusTracker,
    blockMathField,
  ];
}
