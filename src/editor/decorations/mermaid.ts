// Mermaid diagram rendering (MYND-49, mermaid-diagrams tasks 2+3).
//
// Specializes a closed ```mermaid fenced block into a rendered-SVG block widget
// (SYNC-7 whole-block reveal); `fenced-code.ts` skips mermaid info-strings so the
// two block-replaces don't collide. Mermaid is lazy-loaded into
// `mermaidRendererField`. `mermaid.render` is async (like pdfjs), so the widget
// shows a loading state then swaps in the SVG — or, on parse-error / load-failure,
// falls back to a monospace card (the pdfjs generic-fallback precedent). Render-
// only; bytes preserved (§6 C1). Mermaid runs `securityLevel:'strict'`, so its
// SVG is sanitized (SYNC-5).

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import {
  editorFocusChanged,
  editorFocusField,
  editorFocusTracker,
  linesRevealed,
} from "./cursor-aware";
import { loadMermaidRenderer, type MermaidRenderer } from "../mermaid/render-mermaid";
import i18n from "../../i18n";

export const setMermaidRenderer = StateEffect.define<MermaidRenderer>();
export const mermaidRendererField = StateField.define<MermaidRenderer | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMermaidRenderer)) return e.value;
    return value;
  },
});

const mermaidLoaderPlugin = ViewPlugin.fromClass(
  class {
    private destroyed = false;
    constructor(view: EditorView) {
      void loadMermaidRenderer().then((r) => {
        if (this.destroyed) return;
        view.dispatch({ effects: setMermaidRenderer.of(r) });
      });
    }
    destroy() {
      this.destroyed = true;
    }
  },
);

/** Deterministic id from the diagram source (mermaid.render needs a unique id;
 *  deterministic keeps the widget `eq()`-stable across rebuilds). */
function diagramId(code: string): string {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) | 0;
  return "mmd-" + Math.abs(h).toString(36);
}

class MermaidWidget extends WidgetType {
  constructor(
    private readonly code: string,
    private readonly renderer: MermaidRenderer,
    private readonly key: string,
    private readonly from: number,
  ) {
    super();
  }
  eq(other: MermaidWidget): boolean {
    return other.key === this.key && other.from === this.from;
  }
  private fallback(root: HTMLElement, card: HTMLElement): void {
    root.className = "cm-mermaid cm-mermaid-fallback";
    const pre = document.createElement("pre");
    pre.textContent = this.code;
    card.replaceChildren(pre);
  }
  toDOM(view: EditorView): HTMLElement {
    // Outer = transparent, MEASURED spacer (padding, not margin). Inner card
    // carries the fixed-light surface so the diagram reads on either theme.
    const root = document.createElement("div");
    root.className = "cm-mermaid";
    const card = document.createElement("div");
    card.className = "cm-mermaid-card";
    card.textContent = i18n.t("editor.mermaid.rendering");
    root.appendChild(card);

    // Click-to-edit: atomic block widget, so place the cursor at the fence source
    // on click (reveals raw ```mermaid for editing), like the math/table widgets.
    root.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.from }, userEvent: "select.pointer" });
      view.focus();
    });

    void this.renderer(diagramId(this.code), this.code)
      .then(({ svg, error }) => {
        if (error !== null || svg === "") {
          this.fallback(root, card);
        } else {
          card.innerHTML = svg; // securityLevel:'strict' → sanitized SVG (SYNC-5)
        }
        // The SVG/fallback changes the block's height AFTER CM first measured the
        // "Rendering…" placeholder; without a re-measure the height map is stale
        // and every click below the diagram drifts. Request a fresh measure.
        try {
          view.requestMeasure();
        } catch {
          /* view torn down before render settled — nothing to measure */
        }
      })
      .catch(() => {
        this.fallback(root, card);
        try {
          view.requestMeasure();
        } catch {
          /* view torn down */
        }
      });
    return root;
  }
  ignoreEvent(event: Event): boolean {
    return event.type !== "mousedown"; // own the click; ignore the rest
  }
}

function buildMermaid(state: EditorState): DecorationSet {
  const renderer = state.field(mermaidRendererField, false) ?? null;
  if (renderer === null) return Decoration.none;

  const doc = state.doc;
  const blocks: Array<{ from: number; to: number; code: string }> = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return undefined;
      if (node.node.getChildren("CodeMark").length < 2) return false; // closed only
      const infoNode = node.node.getChild("CodeInfo");
      const info = infoNode
        ? doc.sliceString(infoNode.from, infoNode.to).trim().toLowerCase()
        : "";
      if (info !== "mermaid") return false;
      const openLine = doc.lineAt(node.from);
      const closeLine = doc.lineAt(node.to);
      const code = doc
        .sliceString(openLine.to, closeLine.from)
        .replace(/^\n/, "")
        .replace(/\n$/, "");
      blocks.push({ from: openLine.from, to: closeLine.to, code });
      return false;
    },
  });

  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to, code } of blocks) {
    const fromLine = doc.lineAt(from);
    const toLine = doc.lineAt(to);
    if (linesRevealed(state, fromLine.number, toLine.number)) continue;
    builder.add(
      from,
      to,
      Decoration.replace({
        widget: new MermaidWidget(code, renderer, "m:" + code, from),
        block: true,
      }),
    );
  }
  return builder.finish();
}

const mermaidField = StateField.define<DecorationSet>({
  create(state) {
    return buildMermaid(state);
  },
  update(deco, tr) {
    const selectionChanged = !tr.startState.selection.eq(tr.state.selection);
    const rendererChanged = tr.effects.some((e) => e.is(setMermaidRenderer));
    const treeCh = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (
      tr.docChanged ||
      selectionChanged ||
      rendererChanged ||
      editorFocusChanged(tr) ||
      treeCh
    ) {
      return buildMermaid(tr.state);
    }
    return deco;
  },
  provide(f) {
    return EditorView.decorations.from(f);
  },
});

export function mermaidDecorations(): readonly Extension[] {
  return [
    mermaidRendererField,
    mermaidLoaderPlugin,
    editorFocusField,
    editorFocusTracker,
    mermaidField,
  ];
}
