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
} from "@codemirror/view";
import { LineHeightWidget } from "../widget-line-coords";
import {
  editorFocusChanged,
  editorFocusField,
  editorFocusTracker,
  linesRevealed,
} from "./cursor-aware";
import { loadMermaidRenderer, type MermaidRenderer } from "../mermaid/render-mermaid";
import { buildMermaidViewer, type MermaidViewer } from "./mermaid-viewer";
import i18n from "@myne/editor/i18n";

/**
 * Ceiling on a note-declared diagram box, in CSS pixels.
 *
 * The `viewBox` is mermaid's layout of NOTE CONTENT, so its magnitude is chosen
 * by whoever authored the diagram, and `threat-model.md` §7 treats a note as
 * attacker-influenceable (an imported note, or one synced from an A6-class
 * compromised device). Mermaid's own `width="100%"` capped the box at the card
 * whatever the diagram claimed; taking the real width removes that cap, so one
 * is restated here. Availability only, and the card's `max-width: 100%` +
 * `overflow-x: auto` already bound what is painted, which is why the number is
 * generous rather than tight.
 */
const MAX_DIAGRAM_PX = 20_000;

/**
 * Give a rendered diagram its NATURAL pixel size, so the card can scroll it
 * (myne-md/myne#629).
 *
 * Mermaid's `useMaxWidth` default stamps `width="100%"` plus an inline
 * `max-width: <intrinsic>px` on the SVG. A percentage-width child never
 * overflows its container, so the card's `overflow-x: auto` can never engage and
 * the viewBox scales the whole diagram down to whatever the card resolved to. On
 * a three-node `graph TD` that is invisible; on a wide `flowchart LR` it is the
 * reported failure, every node a sub-pixel dot.
 *
 * DONE ON THE LIVE NODE, and both halves of that matter.
 *
 * Not in the config, because `useMaxWidth` lives on `BaseDiagramConfig`, which 26
 * diagram configs extend, and mermaid has no global switch, so a config-side fix
 * means enumerating families, and the first version of this fix enumerated twelve
 * and left `gitGraph`, `sankey`, `block`, `requirement`, `architecture` and nine
 * more still reproducing the bug.
 *
 * And not on the SVG STRING either, which was the second version: parsing
 * mermaid's sanitized output and re-serialising it before an `innerHTML` sink
 * means the bytes the sanitizer produced are no longer the bytes injected, and a
 * string sanitized in an HTML context that is re-parsed as XML and written back
 * is the documented precondition for mutation-XSS. `threat-model.md` §7 states
 * the control as "mermaid sanitizes its own output … and that is what is
 * injected", and that sentence has to stay literally true. Touching the node
 * AFTER it is in the DOM keeps it so: two numeric attributes set, one inline
 * declaration removed, nothing re-parsed and nothing re-serialised.
 *
 * Anything unreadable is left exactly as mermaid drew it. A diagram at the wrong
 * size is cosmetic; a diagram this function broke is not.
 */
export function giveNaturalSize(card: HTMLElement): void {
  const svg = card.querySelector("svg");
  if (svg === null) return;
  const box = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/);
  if (box.length !== 4) return;
  const width = Number(box[2]);
  const height = Number(box[3]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  if (width <= 0 || height <= 0 || width > MAX_DIAGRAM_PX || height > MAX_DIAGRAM_PX) return;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  // The inline `max-width` is the half that outranks any stylesheet, so it has
  // to go rather than be overridden. `removeProperty` touches that one
  // declaration; whatever else mermaid set inline stays.
  svg.style.removeProperty("max-width");
}

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

/** Live viewers by widget root, so `destroy` can unwind their listeners. */
const viewers = new WeakMap<HTMLElement, MermaidViewer>();

/**
 * The accessible name for a rendered diagram: the diagram KIND as Mermaid
 * itself names it (`flowchart`, `sequenceDiagram`, …), which is the first word
 * of the source, or the generic word when the source starts with something
 * else (a directive, a comment, a blank line).
 *
 * Deliberately not the whole source. A diagram body is tens of lines of edge
 * declarations, and an `aria-label` is read as one unbroken run.
 *
 * The named case is its own catalog key rather than the generic word plus a
 * hard-coded ": ". A separator is a translation decision, not punctuation:
 * the spacing, the word order and whether a colon is the right mark at all
 * differ by language, and a joiner frozen in code is one the 31 catalogs
 * cannot reach.
 */
export function mermaidLabel(code: string): string {
  const firstWord =
    code
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "" && !line.startsWith("%%"))
      ?.split(/[\s({[]/)[0] ?? "";
  const kind = /^[A-Za-z][A-Za-z-]*$/.test(firstWord) ? firstWord : null;
  return kind === null
    ? i18n.t("editor.a11y.diagram")
    : i18n.t("editor.a11y.diagramNamed", { kind });
}

class MermaidWidget extends LineHeightWidget {
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
  /** Monospace source card, plus the reason when mermaid gave one.
   *
   *  The reason used to be dropped on the floor (myne-md/myne#629): a diagram
   *  that failed showed its own source and nothing else, so a typo in a node id
   *  and an unsupported diagram type were the same picture. `textContent`, never
   *  `innerHTML`: the string comes from a thrown Error and is not sanitized. */
  private fallback(root: HTMLElement, card: HTMLElement, error: string | null): void {
    root.className = "cm-mermaid cm-mermaid-fallback";
    const pre = document.createElement("pre");
    pre.textContent = this.code;
    if (error === null || error === "") {
      card.replaceChildren(pre);
      return;
    }
    const reason = document.createElement("p");
    reason.className = "cm-mermaid-error";
    reason.textContent = i18n.t("editor.mermaid.renderFailed", { reason: error });
    card.replaceChildren(pre, reason);
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

    // Reveal the raw ```mermaid fence and put the caret on it. The viewer's
    // control bar and a double-click on the diagram both call this (the widget
    // no longer owns `mousedown`, which pan needs).
    const onEdit = () => {
      view.dispatch({
        selection: { anchor: this.from },
        userEvent: "select.pointer",
      });
      view.focus();
    };

    void this.renderer(diagramId(this.code), this.code)
      .then(({ svg, error }) => {
        if (error !== null || svg === "") {
          this.fallback(root, card, error);
        } else {
          card.innerHTML = svg; // securityLevel:'strict' → sanitized SVG (SYNC-5)
          // A named image, not an unnamed graphic (myne-md/myne#728, task 10).
          // A rendered Mermaid SVG is a tree of shapes and text runs; walked by
          // a screen reader it reads as the node labels in whatever order the
          // renderer emitted them, with none of the edges that make it a
          // diagram. `role="img"` collapses it to one object, and the name says
          // what it is and which diagram, taken from the fence's first
          // line, the closest thing to a title the source carries.
          //
          // The role goes on the SVG ROOT, not on the CARD. The interactive
          // viewer (`buildMermaidViewer`, myne-md/myne#708) appends a
          // `role="group"` viewport and zoom/pan/expand/edit buttons as
          // descendants of the card, and `role="img"` makes every descendant
          // PRESENTATIONAL, so a card-level role silently dropped those controls
          // out of the accessibility tree and left invalid nested content. On
          // the SVG, the controls are siblings of the image and stay reachable.
          const svgEl = card.querySelector("svg");
          const labelled = svgEl ?? card;
          labelled.setAttribute("role", "img");
          labelled.setAttribute("aria-label", mermaidLabel(this.code));
          giveNaturalSize(card);
          // The bounded, interactive viewer (myne-md/myne#708). Returns null on
          // an unreadable viewBox, in which case the card stays as drawn.
          const viewer = buildMermaidViewer({
            view,
            card,
            code: this.code,
            onEdit,
          });
          if (viewer !== null) viewers.set(root, viewer);
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
      .catch((e: unknown) => {
        // The loader itself rejected (the lazy chunk never arrived), which the
        // renderer's own try/catch cannot see.
        this.fallback(root, card, e instanceof Error ? e.message : String(e));
        try {
          view.requestMeasure();
        } catch {
          /* view torn down */
        }
      });
    return root;
  }
  /** Unwind the viewer's listeners when CodeMirror drops the widget. Without
   *  this every recycled diagram would leak a window resize listener and a
   *  pointer-capture set. */
  destroy(dom: HTMLElement): void {
    const viewer = viewers.get(dom);
    if (viewer !== undefined) {
      viewer.destroy();
      viewers.delete(dom);
    }
  }
  /** Own every event. The widget handles pan/zoom/edit itself and CodeMirror
   *  must not also act on them (the drawing embed does the same). */
  ignoreEvent(): boolean {
    return true;
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
