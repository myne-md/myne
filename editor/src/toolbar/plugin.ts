// Selection toolbar + inline URL overlay CM6 ViewPlugin.
//
// PRD `editor-mvp-baseline` stories 35-40, 42. The toolbar mounts above an
// active text selection with B / I / S / `<>` / 🔗 / H▾ buttons. The 🔗
// button (and Cmd+K — wired by keymap.ts) opens an inline URL overlay
// adjacent to the selection; Enter wraps as `[selection](url)`, Esc
// dismisses.

import { type Extension } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import { computePosition } from "../positioning";
import { ensureFloatingStyles } from "../floating-styles";
import { wrapCommand, applyHeadingLevel, currentHeadingLevel } from "./commands";
import { isSelectionInCode } from "../code-context";
import { rangeOverlapsAttachmentEmbed } from "../decorations/attachment-embed";
import i18n from "@myne/editor/i18n";

type Mode = "toolbar" | "url-overlay";

const TOOLBAR_BUTTONS = [
  { id: "bold", label: "B", weight: "700", action: wrapCommand("**", "**") },
  { id: "italic", label: "I", weight: "600", italic: true, action: wrapCommand("*", "*") },
  { id: "strike", label: "S", weight: "600", strike: true, action: wrapCommand("~~", "~~") },
  { id: "code", label: "<>", weight: "600", mono: true, action: wrapCommand("`", "`") },
] as const;

/** The default floating-toolbar layout — control ids in render order — used when
 *  no user customization has been fed via {@link setToolbarLayout} (MYND-336).
 *  Matches the pre-customization order exactly. */
const DEFAULT_TOOLBAR_LAYOUT: readonly string[] = [
  "bold",
  "italic",
  "strike",
  "code",
  "highlight",
  "link",
  "heading",
];

/** The user's resolved toolbar layout (shown control ids, in order), or null for
 *  {@link DEFAULT_TOOLBAR_LAYOUT}. Fed from `vault.prefs` by the host (MYND-336)
 *  and read at each render. The floating toolbar is transient (re-renders on
 *  selection), so a config change takes effect on the next selection — no live
 *  reconfigure needed. */
let toolbarLayout: readonly string[] | null = null;

/** Set the resolved floating-toolbar layout (shown ids in order), or `null` to
 *  restore the default. Called by the desktop from its `vault.prefs` sync. */
export function setToolbarLayout(ids: readonly string[] | null): void {
  toolbarLayout = ids;
}

function getToolbarLayout(): readonly string[] | null {
  return toolbarLayout;
}

/** Handler the host wires to run the selection→image export (MYND-361). Crosses
 *  the editor→app seam like {@link setToolbarLayout}; `null` when unset (mobile,
 *  or before the host mounts) — the toolbar then omits the export button. */
let selectionExportHandler: (() => void) | null = null;
export function setSelectionExportHandler(fn: (() => void) | null): void {
  selectionExportHandler = fn;
}

/** Feather-style "image" icon for the export button (static UI chrome, built via
 *  the DOM — no innerHTML). */
function makeExportImageIcon(): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", "3");
  rect.setAttribute("y", "3");
  rect.setAttribute("width", "18");
  rect.setAttribute("height", "18");
  rect.setAttribute("rx", "2");
  const circle = document.createElementNS(ns, "circle");
  circle.setAttribute("cx", "8.5");
  circle.setAttribute("cy", "8.5");
  circle.setAttribute("r", "1.5");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M21 15l-5-5L5 21");
  svg.append(rect, circle, path);
  return svg;
}

// Multi-color highlight palette (decisions.md 2026-06-15). Yellow is the
// DEFAULT: it emits `==…==` (byte-identical to the pre-color behaviour, MYND-156)
// and is what a plain click on the "H" button applies. The other four wrap the
// selection in `<mark class="hl-…">…</mark>` — standard, portable embedded HTML
// constrained to this closed `hl-*` set at the sanitizer (see sanitize.ts
// HIGHLIGHT_CLASSES). The `cssVar` paints each swatch's preview square.
const HIGHLIGHT_SWATCHES = [
  { id: "hl-yellow", labelKey: "editor.toolbar.highlight.yellow", cssVar: "--highlight", open: "==", close: "==" },
  { id: "hl-green", labelKey: "editor.toolbar.highlight.green", cssVar: "--highlight-green", open: '<mark class="hl-green">', close: "</mark>" },
  { id: "hl-blue", labelKey: "editor.toolbar.highlight.blue", cssVar: "--highlight-blue", open: '<mark class="hl-blue">', close: "</mark>" },
  { id: "hl-pink", labelKey: "editor.toolbar.highlight.pink", cssVar: "--highlight-pink", open: '<mark class="hl-pink">', close: "</mark>" },
  { id: "hl-purple", labelKey: "editor.toolbar.highlight.purple", cssVar: "--highlight-purple", open: '<mark class="hl-purple">', close: "</mark>" },
  { id: "hl-orange", labelKey: "editor.toolbar.highlight.orange", cssVar: "--highlight-orange", open: '<mark class="hl-orange">', close: "</mark>" },
  { id: "hl-red", labelKey: "editor.toolbar.highlight.red", cssVar: "--highlight-red", open: '<mark class="hl-red">', close: "</mark>" },
  { id: "hl-teal", labelKey: "editor.toolbar.highlight.teal", cssVar: "--highlight-teal", open: '<mark class="hl-teal">', close: "</mark>" },
  { id: "hl-cyan", labelKey: "editor.toolbar.highlight.cyan", cssVar: "--highlight-cyan", open: '<mark class="hl-cyan">', close: "</mark>" },
  { id: "hl-lime", labelKey: "editor.toolbar.highlight.lime", cssVar: "--highlight-lime", open: '<mark class="hl-lime">', close: "</mark>" },
  { id: "hl-brown", labelKey: "editor.toolbar.highlight.brown", cssVar: "--highlight-brown", open: '<mark class="hl-brown">', close: "</mark>" },
  { id: "hl-grey", labelKey: "editor.toolbar.highlight.grey", cssVar: "--highlight-grey", open: '<mark class="hl-grey">', close: "</mark>" },
  { id: "hl-indigo", labelKey: "editor.toolbar.highlight.indigo", cssVar: "--highlight-indigo", open: '<mark class="hl-indigo">', close: "</mark>" },
] as const;



class ToolbarView implements PluginValue {
  private container: HTMLDivElement | null = null;
  private mode: Mode = "toolbar";
  // Which toolbar dropdown is open, if any. Only one at a time — heading and
  // highlight share this single-slot discriminator so opening one closes the other.
  private openDropdown: "heading" | "highlight" | null = null;
  private urlOverlayOpen = false;
  private savedSelection: { from: number; to: number } | null = null;
  private rafHandle: number | null = null;
  // How many frames the current show attempt has re-tried because the selection's
  // screen coords weren't ready yet (transient `coordsAtPos` null right after a
  // re-focus / measure). Bounded so a genuinely off-screen selection can't spin.
  private coordsRetries = 0;

  // Belt-and-suspenders show trigger: after a mouse selection gesture ends,
  // re-evaluate on the next frame. The transaction-based `update()` path can
  // miss a double-click/drag select (e.g. a re-focus racing the selectionSet),
  // which left the toolbar sporadically unshown after a select/deselect. A
  // mouseup is the unambiguous "selection gesture finished" signal.
  private readonly onMouseUp = (): void => {
    requestAnimationFrame(() => this.refresh());
  };

  constructor(private readonly view: EditorView) {
    ensureFloatingStyles();
    this.view.dom.addEventListener("mouseup", this.onMouseUp);
  }

  update(update: ViewUpdate): void {
    // Dismiss when the editor loses focus (e.g. the Settings modal opens over
    // it) — the body-mounted toolbar would otherwise linger on top of other UI.
    // Only a real blur dismisses; showing is NOT gated on focus (a selection set
    // programmatically, or before focus lands, must still surface the toolbar).
    // The URL-overlay input legitimately holds focus, so keep it up then.
    if (update.focusChanged && !update.view.hasFocus && !this.urlOverlayOpen) {
      this.dismiss();
      return;
    }
    if (
      update.selectionSet ||
      update.docChanged ||
      update.viewportChanged ||
      update.focusChanged ||
      // Re-attempt positioning once the geometry settles — a double-click right
      // after a re-focus can fire selectionSet before the layout is measured, so
      // the first `coordsAtPos` is null; the following geometry update recovers it.
      update.geometryChanged
    ) {
      this.refresh();
    }
  }

  destroy(): void {
    this.view.dom.removeEventListener("mouseup", this.onMouseUp);
    this.dismiss();
  }

  /** Public: open URL overlay programmatically (Cmd+K). */
  openUrlOverlay(): void {
    if (!this.view.state.facet(EditorView.editable)) return; // read-only view
    const range = this.view.state.selection.main;
    if (range.empty) return;
    if (isSelectionInCode(this.view.state)) return; // no link wrapping inside code
    this.savedSelection = { from: range.from, to: range.to };
    this.urlOverlayOpen = true;
    this.mode = "url-overlay";
    this.scheduleRender();
  }

  private refresh(): void {
    const range = this.view.state.selection.main;
    // Never show the formatting toolbar in a non-editable view — reading mode (or
    // the read-only companion mirror) still allows a selection (for copy), but
    // has nothing to format, and the buttons would dispatch changes the editor
    // rejects. `EditorView.editable` is false there (view-mode.ts).
    if (!this.view.state.facet(EditorView.editable)) {
      this.dismiss();
      return;
    }
    // Suppress inside code (MYND-154): formatting a code selection would inject
    // literal markdown markers into the source. Also suppress when the
    // selection touches an attachment embed — an image/PDF atom is not
    // text-formattable, so the inline-mark toolbar must not appear over it.
    const formattingNotApplicable =
      isSelectionInCode(this.view.state) ||
      rangeOverlapsAttachmentEmbed(this.view.state, range.from, range.to);
    if ((range.empty || formattingNotApplicable) && !this.urlOverlayOpen) {
      this.dismiss();
      return;
    }
    if (!this.urlOverlayOpen) {
      this.mode = "toolbar";
      this.scheduleRender();
    }
  }

  private scheduleRender(): void {
    if (this.rafHandle !== null) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      this.render();
    });
  }

  /** Re-attempt `render()` on a later frame when the selection's screen coords
   *  weren't ready (transient `coordsAtPos` null). Bounded so a genuinely
   *  off-screen selection can't spin every frame. */
  private retryRender(): void {
    if (this.coordsRetries >= 4) {
      this.coordsRetries = 0;
      return;
    }
    this.coordsRetries += 1;
    this.scheduleRender();
  }

  private dismiss(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.container !== null) {
      this.container.remove();
      this.container = null;
    }
    this.openDropdown = null;
    this.urlOverlayOpen = false;
    this.savedSelection = null;
    this.coordsRetries = 0;
  }

  private ensureContainer(): HTMLDivElement {
    if (this.container === null) {
      this.container = document.createElement("div");
      // Mount to document.body so position: fixed escapes ancestor
      // containing-block context.
      document.body.appendChild(this.container);
    }
    return this.container;
  }

  private render(): void {
    const range = this.view.state.selection.main;
    if (this.mode === "toolbar" && range.empty) {
      this.dismiss();
      return;
    }
    // Dismiss when the selection has scrolled out of the rendered viewport, so
    // the toolbar doesn't get clamped to and stuck at the viewport edge (QA).
    if (this.mode === "toolbar" && this.savedSelection === null) {
      const inView = this.view.visibleRanges.some(
        (r) => range.head >= r.from && range.head <= r.to,
      );
      if (!inView) {
        this.dismiss();
        return;
      }
    }
    let rect: { left: number; top: number; right: number; bottom: number };
    if (this.mode === "toolbar" && this.savedSelection === null) {
      // Anchor to the selection HEAD (where the drag ended / the caret is) so a
      // multi-line selection surfaces the toolbar near where the pointer last
      // was, not pinned to the very top of the whole selection (QA). A
      // zero-width point at the head; `computePosition` places the toolbar just
      // above that line. Fall back to the anchor/opposite end if the head's
      // coords aren't ready.
      const head =
        this.view.coordsAtPos(range.head) ??
        this.view.coordsAtPos(range.anchor) ??
        this.view.coordsAtPos(range.from);
      if (head === null) {
        this.retryRender();
        return;
      }
      // Also dismiss if the head resolved to a point outside the visible editor
      // band (partially-rendered margin above/below the viewport). Guarded on a
      // real scroller height so jsdom (no layout → a zero rect) doesn't false-dismiss.
      const sc = this.view.scrollDOM.getBoundingClientRect();
      if (sc.bottom > sc.top && (head.bottom < sc.top || head.top > sc.bottom)) {
        this.dismiss();
        return;
      }
      rect = { left: head.left, top: head.top, right: head.left, bottom: head.bottom };
    } else {
      const anchorFrom = this.savedSelection?.from ?? range.from;
      const anchorTo = this.savedSelection?.to ?? range.to;
      const startCoords = this.view.coordsAtPos(anchorFrom);
      const endCoords = this.view.coordsAtPos(anchorTo);
      if (startCoords === null || endCoords === null) {
        this.retryRender();
        return;
      }
      rect = {
        left: Math.min(startCoords.left, endCoords.left),
        top: Math.min(startCoords.top, endCoords.top),
        right: Math.max(startCoords.right, endCoords.right),
        bottom: Math.max(startCoords.bottom, endCoords.bottom),
      };
    }
    this.coordsRetries = 0; // coords resolved — clear the retry budget

    const container = this.ensureContainer();
    container.className = this.mode === "toolbar" ? "cm-toolbar" : "cm-url-overlay";
    container.replaceChildren();
    container.style.position = "fixed";
    container.style.zIndex = "1000";

    if (this.mode === "toolbar") {
      this.renderToolbar(container);
      const pos = computePosition({
        anchor: rect,
        surfaceWidth: 280,
        surfaceHeight: 36,
        preferredPlacement: "above",
        gap: 6,
      });
      container.style.left = `${pos.left}px`;
      container.style.top = `${pos.top}px`;
    } else {
      this.renderUrlOverlay(container);
      const pos = computePosition({
        anchor: rect,
        surfaceWidth: 320,
        surfaceHeight: 36,
        preferredPlacement: "below",
        gap: 6,
      });
      container.style.left = `${pos.left}px`;
      container.style.top = `${pos.top}px`;
      // Auto-focus the input.
      const input = container.querySelector<HTMLInputElement>(
        "input[type='url'], input[type='text']",
      );
      input?.focus();
    }
  }

  private renderToolbar(container: HTMLDivElement): void {
    // MYND-336: render the controls in the user's resolved layout order, hidden
    // ones already filtered out by the host. Falls back to the default layout.
    const layout = getToolbarLayout() ?? DEFAULT_TOOLBAR_LAYOUT;
    // Obsidian-style leading block-type indicator: the heading control renders
    // FIRST (far left) and shows the CURRENT block type, not a generic "H▾" on
    // the right. It is skipped in the layout loop below so it isn't rendered twice.
    if (layout.includes("heading")) {
      this.renderBlockTypeControl(container);
    }
    for (const id of layout) {
      switch (id) {
        case "bold":
        case "italic":
        case "strike":
        case "code": {
          const btn = TOOLBAR_BUTTONS.find((b) => b.id === id);
          if (btn !== undefined) this.renderSimpleButton(container, btn);
          break;
        }
        case "highlight":
          // "H" swatch: plain click = default yellow (==…==); caret opens the
          // 5-color swatch row (MYND-156 + multi-color, decisions.md 2026-06-15).
          this.renderHighlightControl(container);
          break;
        case "link":
          this.renderLinkButton(container);
          break;
        case "heading":
          break; // rendered as the leading block-type control above
        default:
          // The addable list/quote/wikilink commands are not yet rendered on the
          // floating toolbar (MYND-336 follow-up); config still persists them.
          break;
      }
    }
    // Trailing export-selection-as-image button (MYND-361) — only when the host
    // wired the handler. A separate fixed control (not part of the reorderable
    // vocabulary) so it can't be lost from the layout.
    if (selectionExportHandler !== null) {
      this.renderExportButton(container);
    }
  }

  /** The export-selection-as-image button (MYND-361). Delegates to the
   *  host-wired handler which reads the editor-state selection + saves a PNG. */
  private renderExportButton(container: HTMLDivElement): void {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-toolbar-button cm-toolbar-button-export";
    btn.title = i18n.t("editor.toolbar.exportImageTitle");
    btn.setAttribute("aria-label", i18n.t("editor.toolbar.exportImageTitle"));
    btn.appendChild(makeExportImageIcon());
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      selectionExportHandler?.();
    });
    container.appendChild(btn);
  }

  /** One simple inline-formatting button (bold/italic/strike/code). */
  private renderSimpleButton(
    container: HTMLDivElement,
    btn: (typeof TOOLBAR_BUTTONS)[number],
  ): void {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "cm-toolbar-button";
    el.textContent = btn.label;
    el.style.fontWeight = btn.weight;
    if ("italic" in btn && btn.italic) el.style.fontStyle = "italic";
    if ("strike" in btn && btn.strike) el.style.textDecoration = "line-through";
    if ("mono" in btn && btn.mono) el.style.fontFamily = "var(--font-mono)";
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      btn.action(this.view);
    });
    container.appendChild(el);
  }

  /** The link button (opens the URL overlay). */
  private renderLinkButton(container: HTMLDivElement): void {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "cm-toolbar-button cm-toolbar-button-link";
    link.textContent = "↗";
    link.style.fontWeight = "700";
    link.style.fontSize = "16px";
    link.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.openUrlOverlay();
    });
    container.appendChild(link);
  }

  /** Leading block-type control: shows the CURRENT block type (Text / H1..H6)
   *  on the far left (Obsidian parity) and opens the paragraph/H1..H6 dropdown. */
  private renderBlockTypeControl(container: HTMLDivElement): void {
    const level = currentHeadingLevel(this.view);
    const label =
      level === 0 ? i18n.t("editor.toolbar.heading.paragraph") : `H${level}`;
    const headingWrap = document.createElement("div");
    headingWrap.className = "cm-toolbar-heading-wrap cm-toolbar-blocktype-wrap";
    headingWrap.style.position = "relative";
    const headingBtn = document.createElement("button");
    headingBtn.type = "button";
    headingBtn.className = "cm-toolbar-button cm-toolbar-blocktype";
    // Current type + a caret so it reads as an opener.
    headingBtn.textContent = `${label} ▾`;
    headingBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.openDropdown = this.openDropdown === "heading" ? null : "heading";
      this.scheduleRender();
    });
    headingWrap.appendChild(headingBtn);
    if (this.openDropdown === "heading") {
      const drop = document.createElement("div");
      drop.className = "cm-toolbar-heading-dropdown";
      drop.style.position = "absolute";
      drop.style.top = "32px";
      drop.style.left = "0";
      const items: Array<{ label: string; level: number }> = [
        { label: i18n.t("editor.toolbar.heading.paragraph"), level: 0 },
        { label: i18n.t("editor.toolbar.heading.h1"), level: 1 },
        { label: i18n.t("editor.toolbar.heading.h2"), level: 2 },
        { label: i18n.t("editor.toolbar.heading.h3"), level: 3 },
        { label: i18n.t("editor.toolbar.heading.h4"), level: 4 },
        { label: i18n.t("editor.toolbar.heading.h5"), level: 5 },
        { label: i18n.t("editor.toolbar.heading.h6"), level: 6 },
      ];
      for (const item of items) {
        const el = document.createElement("div");
        el.className = "cm-toolbar-heading-item";
        el.textContent = item.label;
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this.openDropdown = null;
          applyHeadingLevel(this.view, item.level);
        });
        drop.appendChild(el);
      }
      headingWrap.appendChild(drop);
    }
    container.appendChild(headingWrap);
  }

  /** Highlight control: an "H" swatch button (plain click = default yellow,
   *  byte-identical to `==…==`) plus a caret that opens a 5-color swatch row.
   *  Non-yellow swatches wrap the selection in `<mark class="hl-…">…</mark>`. */
  private renderHighlightControl(container: HTMLDivElement): void {
    const wrap = document.createElement("div");
    wrap.className = "cm-toolbar-highlight-wrap";
    wrap.style.position = "relative";

    // Main button: applies the default yellow highlight on a plain click.
    const mainBtn = document.createElement("button");
    mainBtn.type = "button";
    mainBtn.className = "cm-toolbar-button";
    mainBtn.setAttribute("data-testid", "toolbar.highlight");
    const swatch = document.createElement("span");
    swatch.textContent = "H";
    swatch.style.backgroundColor = "var(--highlight, #f3e7c4)";
    swatch.style.padding = "0 3px";
    swatch.style.borderRadius = "2px";
    swatch.style.color = "var(--fg-1)";
    mainBtn.appendChild(swatch);
    mainBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.openDropdown = null;
      wrapCommand("==", "==")(this.view);
    });
    wrap.appendChild(mainBtn);

    // Caret: opens/closes the color swatch row.
    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "cm-toolbar-button cm-toolbar-highlight-caret";
    caret.textContent = "▾";
    caret.setAttribute("data-testid", "toolbar.highlight-caret");
    caret.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.openDropdown = this.openDropdown === "highlight" ? null : "highlight";
      this.scheduleRender();
    });
    wrap.appendChild(caret);

    if (this.openDropdown === "highlight") {
      const drop = document.createElement("div");
      drop.className = "cm-toolbar-highlight-dropdown";
      drop.style.position = "absolute";
      drop.style.top = "32px";
      drop.style.left = "0";
      for (const sw of HIGHLIGHT_SWATCHES) {
        const square = document.createElement("button");
        square.type = "button";
        square.className = "cm-toolbar-highlight-swatch";
        square.title = i18n.t(sw.labelKey);
        square.setAttribute("data-testid", `toolbar.highlight-${sw.id}`);
        square.style.backgroundColor = `var(${sw.cssVar})`;
        square.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this.openDropdown = null;
          wrapCommand(sw.open, sw.close)(this.view);
        });
        drop.appendChild(square);
      }
      wrap.appendChild(drop);
    }
    container.appendChild(wrap);
  }

  private renderUrlOverlay(container: HTMLDivElement): void {
    const input = document.createElement("input");
    input.type = "url";
    input.placeholder = i18n.t("editor.toolbar.urlPlaceholder");
    input.className = "cm-url-overlay-input";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = i18n.t("editor.toolbar.apply");
    apply.className = "cm-url-overlay-apply";

    const commit = (): void => {
      const url = input.value.trim();
      const sel = this.savedSelection;
      if (sel !== null && url !== "") {
        const text = this.view.state.doc.sliceString(sel.from, sel.to);
        this.view.dispatch({
          changes: {
            from: sel.from,
            to: sel.to,
            insert: `[${text}](${url})`,
          },
          userEvent: "toolbar.link",
        });
      }
      this.dismiss();
      this.view.focus();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.dismiss();
        this.view.focus();
      }
    });
    apply.addEventListener("mousedown", (e) => {
      e.preventDefault();
      commit();
    });
    container.append(input, apply);
  }
}

export function selectionToolbarExtension(): Extension {
  return ViewPlugin.fromClass(ToolbarView);
}
