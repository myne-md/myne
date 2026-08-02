// Inline drawing-embed rendering (MYND-634 / drawing-inline-embed, SF6 + the new
// edit-in-place scope). An `![[Title]]` embed whose target is a `kind: drawing`
// note renders inline as a THUMBNAIL by default, and — on click — becomes a live,
// edit-in-place Excalidraw canvas, collapsing back to the thumbnail on "Done".
//
// This is a near-twin of `attachment-embed.ts`: an inline ATOMIC replace built by
// a ViewPlugin over the visible ranges, plus an `atomicRanges` provider so the
// caret skips the widget (the raw `![[Title]]` is never exposed — backspace at the
// edge removes the whole reference, which is exactly "unlink", and per the feature
// decision leaves the drawing NOTE intact). The wikilink chip builder is taught to
// defer drawing embeds here (via `isDrawing`, already computed there) so a range is
// never double-decorated.
//
// NO PERSISTED LOCK. The thumbnail↔canvas state is transient view state (an
// `activeDrawingEmbedField` holding at most one note id), never a marker written
// to the markdown — so the note body stays clean `![[Title]]` and the state never
// syncs. Perf follows for free: only the ONE embed the user is editing mounts a
// live (heavy, lazy) Excalidraw; every other drawing on the page is a cheap image.
//
// Note-CRUD crosses the package boundary through the injected `DrawingEmbedIo`
// facet (`readScene`/`saveScene`), never a new `EditorHost` member — see
// `drawing/embed-io.ts`. Excalidraw stays lazy: `renderScene` and the canvas both
// arrive via dynamic import, so a drawing-free note pays nothing.

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
import type { SyntaxNode } from "@lezer/common";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import i18n from "@myne/editor/i18n";
import { parseWikilinkParts } from "../wikilink/chip-widget";
import { readNoteSet } from "../wikilink/note-set";
import { chipKeySets, isDrawingEmbed, resolveChipParts } from "../wikilink/resolve-chip";
import { drawingEmbedIoFacet, readDrawingEmbedIo, type DrawingEmbedIo } from "../drawing/embed-io";
import { InlineDrawingCanvas } from "../drawing/InlineDrawingCanvas";
import { readingModeFacet } from "./cursor-aware";

/** The note id currently opened for edit-in-place, or `null` when every drawing
 *  embed is a thumbnail. Set by `setActiveDrawingEmbed`; transient view state. */
export const setActiveDrawingEmbed = StateEffect.define<string | null>();

export const activeDrawingEmbedField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setActiveDrawingEmbed)) return e.value;
    return value;
  },
});

/** The resolved drawing note id + display label for a `Wikilink` node, or `null`
 *  when the node is not a resolvable drawing embed (leave it to the chip). */
function drawingEmbedInfo(
  state: EditorState,
  node: SyntaxNode,
  drawingKeys: ReadonlySet<string>,
): { noteId: string; display: string } | null {
  const parts = parseWikilinkParts(state, node.from, node.to);
  if (!isDrawingEmbed(parts, drawingKeys)) return null;
  const res = resolveChipParts(parts, readNoteSet(state));
  if (res === null || res.status !== "resolved") return null;
  return { noteId: res.noteUuid, display: parts.alias ?? parts.target ?? "" };
}

/** True iff this `Wikilink` node is a drawing embed. Exported so the wikilink chip
 *  builder defers these ranges here (no double decoration). */
export function isDrawingEmbedNode(state: EditorState, node: SyntaxNode): boolean {
  const { drawings } = chipKeySets(readNoteSet(state));
  return drawingEmbedInfo(state, node, drawings) !== null;
}

// The live React root is kept on the widget's DOM NODE, not the widget instance,
// so `updateDOM` can reuse the node across a thumbnail↔canvas transition (which is
// what stops the editor from scroll-jumping when the widget's height changes) and
// `destroy(dom)` can still tear the canvas down.
const rootByDom = new WeakMap<HTMLElement, Root>();

function unmountRoot(dom: HTMLElement): void {
  const root = rootByDom.get(dom);
  if (root === undefined) return;
  rootByDom.delete(dom);
  // Defer: React refuses a synchronous unmount during a render / commit, which is
  // exactly when CM tears a widget down or swaps its content.
  queueMicrotask(() => root.unmount());
}

/** Whether a scene JSON has any drawn elements. An empty (brand-new) scene gets a
 *  clean placeholder rather than a rendered-empty-canvas thumbnail (which reads as
 *  a big dark box, #213 review). Parse failure counts as empty (safe). */
function sceneHasElements(sceneJson: string): boolean {
  try {
    const scene = JSON.parse(sceneJson) as { elements?: unknown };
    return Array.isArray(scene.elements) && scene.elements.length > 0;
  } catch {
    return false;
  }
}

/** The live app theme (mirrors DrawingCanvas's `currentAppTheme`): `data-theme`
 *  wins, else the OS preference. Drives the thumbnail's dark-mode render + its
 *  backdrop so the collapsed state uses the SAME palette as the edit canvas
 *  (#213 review). */
function isDarkApp(): boolean {
  if (typeof document === "undefined") return true;
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "light") return false;
  if (t === "dark" || t === "amoled") return true;
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
}

/** The Excalidraw canvas backdrop for the current theme — the same near-black
 *  its dark-mode transform paints (white → invert(93%) ≈ #121212), so the
 *  collapsed thumbnail sits on the identical surface as the live canvas. */
function canvasBackdrop(): string {
  return isDarkApp() ? "#121212" : "#ffffff";
}

class DrawingEmbedWidget extends WidgetType {
  constructor(
    private readonly noteId: string,
    private readonly display: string,
    private readonly active: boolean,
    private readonly io: DrawingEmbedIo | null,
    /** Source position — part of widget identity (the chip-widget lesson). */
    private readonly from: number,
  ) {
    super();
  }

  private mode(): "inert" | "editing" | "thumbnail" {
    return this.io === null ? "inert" : this.active ? "editing" : "thumbnail";
  }

  eq(other: DrawingEmbedWidget): boolean {
    return (
      other.noteId === this.noteId &&
      other.active === this.active &&
      other.display === this.display &&
      other.from === this.from &&
      (other.io === null) === (this.io === null)
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-drawing-embed";
    container.setAttribute("data-testid", "editor.drawing-embed");
    this.render(container, view);
    return container;
  }

  // Reuse the existing DOM node across state changes (CM calls this instead of
  // recreating when `eq` is false). Reusing the node is what keeps the editor's
  // scroll anchored through a thumbnail↔canvas height change. A title-only change
  // updates in place WITHOUT tearing down the (heavy) canvas.
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const sameNote = dom.dataset.renderedNote === this.noteId;
    const sameMode = dom.dataset.renderedMode === this.mode();
    if (!sameNote || !sameMode) {
      this.render(dom, view);
      return true;
    }
    if (dom.dataset.renderedDisplay !== this.display) {
      this.updateDisplay(dom);
    }
    return true;
  }

  /** (Re)render `dom` to this widget's current state, tearing down any live
   *  canvas root first. Keeps the node; swaps its children. Thumbnail and editing
   *  share ONE frame + header — only the action button (Edit/Done) and the body
   *  (image vs canvas) differ, and both bodies are the same height, so toggling is
   *  seamless (no scroll jump) and the two states read as one widget (#213 review). */
  private render(dom: HTMLElement, view: EditorView): void {
    unmountRoot(dom);
    while (dom.firstChild !== null) dom.removeChild(dom.firstChild);
    dom.setAttribute("data-note-id", this.noteId);
    dom.dataset.renderedNote = this.noteId;
    dom.dataset.renderedMode = this.mode();
    dom.dataset.renderedDisplay = this.display;
    const io = this.io;
    if (io === null) {
      dom.setAttribute("data-drawing-embed-state", "inert");
      dom.removeAttribute("data-drawing-embed-active");
      const label = document.createElement("span");
      label.className = "cm-drawing-embed-label";
      label.textContent = this.display;
      dom.appendChild(label);
      return;
    }
    dom.appendChild(this.buildHeader(view, io));
    if (this.active) {
      dom.setAttribute("data-drawing-embed-state", "editing");
      dom.setAttribute("data-drawing-embed-active", "true");
      this.mountCanvas(dom, io);
    } else {
      dom.setAttribute("data-drawing-embed-state", "thumbnail");
      dom.removeAttribute("data-drawing-embed-active");
      this.renderThumbnailBody(dom, view, io);
    }
  }

  /** Title-only update (a rename landed) — no canvas teardown. */
  private updateDisplay(dom: HTMLElement): void {
    dom.dataset.renderedDisplay = this.display;
    const label = dom.querySelector<HTMLElement>(".cm-drawing-embed-label");
    if (label !== null) label.textContent = this.display;
    const input = dom.querySelector<HTMLInputElement>(".cm-drawing-embed-title-input");
    // Don't clobber the field the user is actively typing a new name into.
    if (input !== null && document.activeElement !== input) input.value = this.display;
    const body = dom.querySelector<HTMLElement>(".cm-drawing-embed-body");
    if (body !== null) {
      body.setAttribute("aria-label", i18n.t("editor.drawingEmbed.edit", { name: this.display }));
    }
  }

  /** The shared header: an editable title + the Edit (thumbnail) / Done (editing)
   *  action button. Identical in both states bar the button. */
  private buildHeader(view: EditorView, io: DrawingEmbedIo): HTMLElement {
    const header = document.createElement("div");
    header.className = "cm-drawing-embed-header";
    const noteId = this.noteId;
    // Editable title — renaming routes through the transactional rename so the
    // `![[Title]]` embed reference is rewritten too (#213 review).
    const title = document.createElement("input");
    title.type = "text";
    title.className = "cm-drawing-embed-title-input";
    title.setAttribute("data-testid", "editor.drawing-embed.title");
    title.value = this.display;
    title.setAttribute("aria-label", i18n.t("editor.drawingEmbed.rename"));
    const original = this.display;
    const commitRename = () => {
      const next = title.value.trim();
      if (next === "" || next === original) {
        title.value = original;
        return;
      }
      void io.renameDrawing(noteId, next).catch(() => {
        title.value = original;
      });
    };
    title.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep the editor keymap out of the rename field
      if (e.key === "Enter") {
        e.preventDefault();
        title.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        title.value = original;
        title.blur();
      }
    });
    title.addEventListener("blur", commitRename);
    header.appendChild(title);

    const action = document.createElement("button");
    action.type = "button";
    action.className = "cm-drawing-embed-action";
    if (this.active) {
      action.textContent = i18n.t("editor.drawingEmbed.done");
      action.setAttribute("data-testid", "editor.drawing-embed.collapse");
      action.addEventListener("click", (e) => {
        e.preventDefault();
        view.dispatch({ effects: setActiveDrawingEmbed.of(null) });
      });
    } else {
      action.textContent = i18n.t("editor.drawingEmbed.editAction");
      action.setAttribute("data-testid", "editor.drawing-embed.edit-button");
      action.addEventListener("click", (e) => {
        e.preventDefault();
        view.dispatch({ effects: setActiveDrawingEmbed.of(noteId) });
      });
    }
    header.appendChild(action);
    return header;
  }

  /** Thumbnail body (same-size as the canvas): the rendered scene, or a clean
   *  placeholder for an empty drawing. Clicking it opens the canvas. */
  private renderThumbnailBody(container: HTMLElement, view: EditorView, io: DrawingEmbedIo): void {
    const body = document.createElement("div");
    body.className = "cm-drawing-embed-body";
    body.setAttribute("data-testid", "editor.drawing-embed.thumbnail");
    body.setAttribute("role", "button");
    body.setAttribute("tabindex", "0");
    body.setAttribute("aria-label", i18n.t("editor.drawingEmbed.edit", { name: this.display }));
    // Same backdrop as the live Excalidraw canvas, so collapsed ⇄ editing share
    // one palette (#213 review).
    const dark = isDarkApp();
    body.style.backgroundColor = canvasBackdrop();
    body.addEventListener("click", (e) => {
      e.preventDefault();
      view.dispatch({ effects: setActiveDrawingEmbed.of(this.noteId) });
    });
    container.appendChild(body);
    const noteId = this.noteId;
    const label = this.display;
    // Render the scene to a PNG. Excalidraw is pulled lazily here, so a note with
    // no drawings never loads it. `darkMode` from the live app theme makes the
    // export match the editor (a dark-drawn scene's strokes are stored dark and
    // inverted on display — without this they render faint). An empty / brand-new
    // drawing shows a clean hint rather than a rendered-empty canvas.
    void (async () => {
      const scene = await io.readScene(noteId).catch(() => null);
      if (scene === null || !sceneHasElements(scene)) {
        body.setAttribute("data-empty", "true");
        const hint = document.createElement("span");
        hint.className = "cm-drawing-embed-empty-hint";
        hint.textContent = i18n.t("editor.drawingEmbed.empty");
        body.appendChild(hint);
        return;
      }
      const { renderSceneDataUri } = await import("../drawing/renderScene");
      const uri = await renderSceneDataUri(scene, { scale: 2, darkMode: dark }).catch(() => null);
      if (uri === null || !body.isConnected) return;
      const img = document.createElement("img");
      img.className = "cm-drawing-embed-img";
      img.src = uri;
      img.alt = label;
      body.appendChild(img);
    })();
  }

  /** Editing body: the live Excalidraw canvas, mounted via a React root kept on
   *  the widget DOM node (torn down in `render` / `destroy`). */
  private mountCanvas(container: HTMLElement, io: DrawingEmbedIo): void {
    const host = document.createElement("div");
    host.className = "cm-drawing-embed-canvas";
    container.appendChild(host);
    const noteId = this.noteId;
    void (async () => {
      const { createRoot } = await import("react-dom/client");
      // The node may have been re-rendered (fast collapse) before this resolves —
      // bail so we never mount into a stale host.
      if (!host.isConnected) return;
      const root = createRoot(host);
      rootByDom.set(container, root);
      root.render(createElement(InlineDrawingCanvas, { io, noteId }));
    })();
  }

  destroy(dom: HTMLElement): void {
    unmountRoot(dom);
  }

  // The widget owns every event inside it (the thumbnail button, the title field,
  // the Done button, and the whole Excalidraw canvas) — the editor must not treat
  // clicks/keys here as content interaction.
  ignoreEvent(): boolean {
    return true;
  }
}

function buildDrawingEmbedDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const io = readDrawingEmbedIo(state);
  const { drawings } = chipKeySets(readNoteSet(state));
  // Reading mode makes the host note read-only; an inline drawing there is a
  // static thumbnail, never an editable canvas.
  const reading = state.facet(readingModeFacet);
  const active = reading ? null : state.field(activeDrawingEmbedField, false) ?? null;
  const decorations: Array<Range<Decoration>> = [];
  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Wikilink") return undefined;
        const info = drawingEmbedInfo(state, node.node, drawings);
        if (info === null) return false;
        decorations.push(
          Decoration.replace({
            widget: new DrawingEmbedWidget(
              info.noteId,
              info.display,
              active === info.noteId,
              io,
              node.from,
            ),
            atomic: true,
          }).range(node.from, node.to),
        );
        return false;
      },
    });
  }
  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => a.from - b.from);
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

// Atomic-range set keyed by the syntax tree — same pattern (and same note-set
// staleness edge) as `cachedAttachmentAtomicRanges`. A typed `![[Drawing]]` changes
// the tree, so the common path invalidates.
const atomicCache = new WeakMap<
  ReturnType<typeof syntaxTree>,
  ReturnType<RangeSetBuilder<Decoration>["finish"]>
>();

function cachedDrawingAtomicRanges(view: EditorView) {
  const tree = syntaxTree(view.state);
  const cached = atomicCache.get(tree);
  if (cached !== undefined) return cached;
  const { drawings } = chipKeySets(readNoteSet(view.state));
  const ranges: Array<Range<Decoration>> = [];
  tree.iterate({
    from: 0,
    to: view.state.doc.length,
    enter: (node) => {
      if (node.name === "Wikilink") {
        if (drawingEmbedInfo(view.state, node.node, drawings) !== null) {
          ranges.push(Decoration.replace({}).range(node.from, node.to));
        }
        return false;
      }
      return undefined;
    },
  });
  const builder = new RangeSetBuilder<Decoration>();
  ranges.sort((a, b) => a.from - b.from);
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  const finished = builder.finish();
  atomicCache.set(tree, finished);
  return finished;
}

// The ViewPlugin + atomic ranges only — VIEW-MODE-GATED (composed into
// `myneDecorations()`, which source mode empties so `![[Drawing]]` shows raw).
// The `activeDrawingEmbedField` + the IO facet are mounted mode-INDEPENDENTLY in
// `myneExtensions()` so the edit-in-place state survives a mode switch and the
// host can reconfigure the IO seam regardless of mode.
export function drawingEmbedDecorations(): readonly Extension[] {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = buildDrawingEmbedDecorations(view.state, view.visibleRanges);
        }
        update(update: ViewUpdate) {
          const noteSetChanged = readNoteSet(update.startState) !== readNoteSet(update.state);
          const ioChanged =
            update.startState.facet(drawingEmbedIoFacet) !==
            update.state.facet(drawingEmbedIoFacet);
          const activeChanged =
            (update.startState.field(activeDrawingEmbedField, false) ?? null) !==
            (update.state.field(activeDrawingEmbedField, false) ?? null);
          if (
            update.docChanged ||
            update.viewportChanged ||
            noteSetChanged ||
            ioChanged ||
            activeChanged ||
            syntaxTree(update.startState) !== syntaxTree(update.state)
          ) {
            this.decorations = buildDrawingEmbedDecorations(update.state, update.view.visibleRanges);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
    EditorView.atomicRanges.of(cachedDrawingAtomicRanges),
  ];
}
