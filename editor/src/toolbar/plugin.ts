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
import { toggleWrap } from "../wrap-toggle";
import { isSelectionInCode } from "../code-context";
import { rangeOverlapsAttachmentEmbed } from "../decorations/attachment-embed";
import i18n from "@myne/editor/i18n";

type Mode = "toolbar" | "url-overlay";

const TOOLBAR_BUTTONS = [
  { id: "bold", label: "B", weight: "700", action: toggleAction("**", "**") },
  { id: "italic", label: "I", weight: "600", italic: true, action: toggleAction("*", "*") },
  { id: "strike", label: "S", weight: "600", strike: true, action: toggleAction("~~", "~~") },
  { id: "code", label: "<>", weight: "600", mono: true, action: toggleAction("`", "`") },
] as const;

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
] as const;

function toggleAction(open: string, close: string) {
  const cmd = toggleWrap(open, close);
  return (view: EditorView): void => {
    cmd({ state: view.state, dispatch: view.dispatch.bind(view) });
    view.focus();
  };
}

function applyHeadingLevel(view: EditorView, level: number): void {
  const range = view.state.selection.main;
  const line = view.state.doc.lineAt(range.from);
  const text = view.state.doc.sliceString(line.from, line.to);
  const cleaned = text.replace(/^#{1,6}\s+/, "");
  const next = level === 0 ? cleaned : "#".repeat(level) + " " + cleaned;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: next },
    userEvent: "toolbar.heading",
  });
  view.focus();
}

class ToolbarView implements PluginValue {
  private container: HTMLDivElement | null = null;
  private mode: Mode = "toolbar";
  // Which toolbar dropdown is open, if any. Only one at a time — heading and
  // highlight share this single-slot discriminator so opening one closes the other.
  private openDropdown: "heading" | "highlight" | null = null;
  private urlOverlayOpen = false;
  private savedSelection: { from: number; to: number } | null = null;
  private rafHandle: number | null = null;

  constructor(private readonly view: EditorView) {
    ensureFloatingStyles();
  }

  update(update: ViewUpdate): void {
    if (
      update.selectionSet ||
      update.docChanged ||
      update.viewportChanged
    ) {
      this.refresh();
    }
  }

  destroy(): void {
    this.dismiss();
  }

  /** Public: open URL overlay programmatically (Cmd+K). */
  openUrlOverlay(): void {
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
    const anchorFrom = this.savedSelection?.from ?? range.from;
    const anchorTo = this.savedSelection?.to ?? range.to;
    const startCoords = this.view.coordsAtPos(anchorFrom);
    const endCoords = this.view.coordsAtPos(anchorTo);
    if (startCoords === null || endCoords === null) return;
    const rect = {
      left: Math.min(startCoords.left, endCoords.left),
      top: Math.min(startCoords.top, endCoords.top),
      right: Math.max(startCoords.right, endCoords.right),
      bottom: Math.max(startCoords.bottom, endCoords.bottom),
    };

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
    for (const btn of TOOLBAR_BUTTONS) {
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
    // Highlight (MYND-156 + multi-color, decisions.md 2026-06-15): an "H" swatch
    // whose plain click applies the DEFAULT yellow (`==…==`), plus a caret that
    // opens a 5-color swatch row. Mirrors the heading dropdown structure below.
    this.renderHighlightControl(container);
    // Link button.
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
    // Heading dropdown.
    const headingWrap = document.createElement("div");
    headingWrap.className = "cm-toolbar-heading-wrap";
    headingWrap.style.position = "relative";
    const headingBtn = document.createElement("button");
    headingBtn.type = "button";
    headingBtn.className = "cm-toolbar-button";
    headingBtn.textContent = "H▾";
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
      toggleAction("==", "==")(this.view);
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
          toggleAction(sw.open, sw.close)(this.view);
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
