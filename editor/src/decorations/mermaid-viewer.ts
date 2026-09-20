// Bounded, interactive viewer for a rendered mermaid diagram (myne-md/myne#708).
//
// Mermaid draws the SVG at its natural size and the widget used to show it as a
// static card: horizontal scroll only, the vertical axis unbounded, and every
// `mousedown` dropped back to source so a drag could never start. This wraps the
// SVG in a clipping viewport, fits it to the column, and drives the SHARED
// pan/zoom controller (`attachments/image-zoom-controller.ts`).
//
// Render-only, and the mechanism is what keeps that true: zoom and pan are a CSS
// `transform` on the LIVE SVG node already in the DOM. Nothing is re-parsed,
// nothing is re-serialised, and no second `innerHTML` sink is added, so
// `docs/threat-model.md` §7's "mermaid sanitizes its own output and that is what
// is injected" stays literally true. The note's bytes are never touched.
//
// Chrome: the pan/zoom cluster is GitHub's (a 3x3 grid bottom-right: up and
// zoom-in on the top row, left/reset/right in the middle, down and zoom-out on
// the bottom), and the edit affordance sits top-right as an icon plus the word
// "Edit", the way the app's own window chrome reads. Everything is shared by
// desktop, web and mobile: the chrome is always visible rather than
// hover-revealed because the mobile WebView has no hover, and the controller
// carries the pinch path for touch.

import type { EditorView } from "@codemirror/view";
import i18n from "@myne/editor/i18n";
import {
  mountZoom,
  type ContentBox,
  type ZoomPanController,
} from "../attachments/image-zoom-controller";
import { mermaidZoomStore } from "../attachments/session-caches";
import { ensureMermaidViewerStyles } from "./mermaid-viewer-styles";

/** Ceiling on a note-declared diagram box, in CSS px. Same availability bound
 *  `giveNaturalSize` states, restated because this module reads the viewBox
 *  itself. */
const MAX_DIAGRAM_PX = 20_000;
/** Height cap, a fraction of the editor viewport (myne-md/myne#708's "not a
 *  magic pixel constant"), with a floor so a short pane still shows something
 *  and a ceiling so a tall window does not turn the card into a second screen. */
const MIN_VIEWPORT_PX = 160;
const MAX_VIEWPORT_PX = 560;
const VIEWPORT_FRACTION = 0.55;
/** Pan distance for the arrow buttons and the arrow keys, in stage px. */
const PAN_STEP = 100;

/**
 * The VISIBLE editor slot, in viewport coordinates.
 *
 * Not `view.dom.getBoundingClientRect()`: on the desktop client the CodeMirror
 * editor grows to its content height and an app-level scroller moves it, so the
 * editor's own rect is the whole note rather than the slot on screen. Rather than
 * guess which ancestor clips (there is more than one, and their class names are
 * not this module's to know), the editor's rect is intersected with every
 * ancestor and with the window: what survives is exactly the visible slot.
 */
function editorSlotRect(view: EditorView): DOMRect {
  const own = view.dom.getBoundingClientRect();
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  let left = Math.max(own.left, 0);
  let top = Math.max(own.top, 0);
  let right = Math.min(own.right, winW);
  let bottom = Math.min(own.bottom, winH);
  let el: HTMLElement | null = view.dom.parentElement;
  while (el !== null) {
    const r = el.getBoundingClientRect();
    // A zero-area ancestor (a collapsed or display:none wrapper) would clip
    // everything to nothing and is not the slot; skipping it is what keeps the
    // intersection meaningful.
    if (r.width > 0 && r.height > 0) {
      left = Math.max(left, r.left);
      top = Math.max(top, r.top);
      right = Math.min(right, r.right);
      bottom = Math.min(bottom, r.bottom);
    }
    el = el.parentElement;
  }
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  if (width < 40 || height < 40) {
    // Never hand back more than the window, even on the degenerate path: the
    // whole failure this replaces was an overlay 1580px tall in a 720px window.
    return new DOMRect(
      Math.max(own.left, 0),
      Math.max(own.top, 0),
      Math.min(own.right, winW) - Math.max(own.left, 0),
      Math.min(own.bottom, winH) - Math.max(own.top, 0),
    );
  }
  return new DOMRect(left, top, width, height);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Stable session-store key for a diagram's source. */
export function mermaidSourceKey(code: string): string {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** The SVG's natural (viewBox) box, or null when it is unreadable / over cap. */
export function mermaidNaturalSize(
  svg: SVGSVGElement,
): { w: number; h: number } | null {
  const box = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/);
  if (box.length !== 4) return null;
  const w = Number(box[2]);
  const h = Number(box[3]);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w <= 0 || h <= 0 || w > MAX_DIAGRAM_PX || h > MAX_DIAGRAM_PX) return null;
  return { w, h };
}

export interface MermaidViewer {
  destroy(): void;
  /** Re-fit after the editor viewport changed size. */
  remeasure(): void;
}

/** Lucide-shaped paths, drawn as DOM (never `innerHTML`, never emoji — TB2),
 *  1.5px stroke in `currentColor` so they inherit the button's token colour. */
const ICONS: Record<string, readonly string[]> = {
  "chevron-up": ["m18 15-6-6-6 6"],
  "chevron-down": ["m6 9 6 6 6-6"],
  "chevron-left": ["m15 18-6-6 6-6"],
  "chevron-right": ["m9 18 6-6-6-6"],
  "zoom-in": [
    "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
    "m21 21-4.35-4.35",
    "M11 8v6",
    "M8 11h6",
  ],
  "zoom-out": [
    "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
    "m21 21-4.35-4.35",
    "M8 11h6",
  ],
  reset: [
    "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",
    "M3 3v5h5",
  ],
  pencil: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"],
  maximize: [
    "M8 3H5a2 2 0 0 0-2 2v3",
    "M21 8V5a2 2 0 0 0-2-2h-3",
    "M3 16v3a2 2 0 0 0 2 2h3",
    "M16 21h3a2 2 0 0 0 2-2v-3",
  ],
  x: ["M18 6 6 18", "m6 6 12 12"],
};

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/** One square icon button for the pan/zoom cluster. */
function gridButton(
  area: string,
  testid: string,
  label: string,
  iconName: keyof typeof ICONS,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `cm-mermaid-control cm-mermaid-control-${area}`;
  button.setAttribute("data-testid", testid);
  button.setAttribute("aria-label", label);
  button.title = label;
  button.appendChild(icon(iconName));
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return button;
}

/** One icon-plus-word button for the top-right chrome. */
function chromeButton(
  testid: string,
  label: string,
  text: string,
  iconName: keyof typeof ICONS,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-mermaid-chrome";
  button.setAttribute("data-testid", testid);
  button.setAttribute("aria-label", label);
  button.title = label;
  const span = document.createElement("span");
  span.className = "cm-mermaid-chrome-text";
  span.textContent = text;
  button.append(icon(iconName), span);
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return button;
}

/** GitHub's 3x3 pan/zoom cluster, bottom-right. */
function buildGrid(getController: () => ZoomPanController | null): HTMLDivElement {
  const grid = document.createElement("div");
  grid.className = "cm-mermaid-controls";
  grid.append(
    gridButton("up", "editor.mermaid.pan-up", i18n.t("editor.mermaid.panUp"), "chevron-up", () =>
      getController()?.pan(0, PAN_STEP),
    ),
    gridButton("zin", "editor.mermaid.zoom-in", i18n.t("editor.mermaid.zoomIn"), "zoom-in", () =>
      getController()?.zoomIn(),
    ),
    gridButton("lft", "editor.mermaid.pan-left", i18n.t("editor.mermaid.panLeft"), "chevron-left", () =>
      getController()?.pan(PAN_STEP, 0),
    ),
    gridButton("rst", "editor.mermaid.reset", i18n.t("editor.mermaid.reset"), "reset", () =>
      getController()?.reset(),
    ),
    gridButton("rgt", "editor.mermaid.pan-right", i18n.t("editor.mermaid.panRight"), "chevron-right", () =>
      getController()?.pan(-PAN_STEP, 0),
    ),
    gridButton("dwn", "editor.mermaid.pan-down", i18n.t("editor.mermaid.panDown"), "chevron-down", () =>
      getController()?.pan(0, -PAN_STEP),
    ),
    gridButton("zot", "editor.mermaid.zoom-out", i18n.t("editor.mermaid.zoomOut"), "zoom-out", () =>
      getController()?.zoomOut(),
    ),
  );
  return grid;
}

/**
 * Turn an already-rendered mermaid card into a viewer.
 *
 * Returns null when the SVG's natural box cannot be read, in which case the card
 * is left exactly as mermaid drew it (a diagram at the wrong size is cosmetic; a
 * diagram this broke is not).
 */
export function buildMermaidViewer(opts: {
  view: EditorView;
  card: HTMLElement;
  code: string;
  onEdit: () => void;
}): MermaidViewer | null {
  const svg = opts.card.querySelector("svg");
  if (!(svg instanceof SVGSVGElement)) return null;
  const natural = mermaidNaturalSize(svg);
  if (natural === null) return null;
  // The chrome is styled from a global sheet: the expanded viewer lives outside
  // CodeMirror's theme scope (see mermaid-viewer-styles.ts).
  ensureMermaidViewerStyles();

  const viewport = document.createElement("div");
  viewport.className = "cm-mermaid-viewport";
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "group");
  viewport.setAttribute("aria-label", i18n.t("editor.mermaid.viewerLabel"));
  // The frame is the positioning context for the chrome, so the chrome is a
  // SIBLING of the clipping viewport and cannot be clipped by it.
  const frame = document.createElement("div");
  frame.className = "cm-mermaid-frame";
  opts.card.classList.add("cm-mermaid-card-viewer");
  opts.card.appendChild(frame);
  frame.appendChild(viewport);
  // Move the LIVE node in, never clone or re-serialise it (threat-model §7).
  viewport.appendChild(svg);
  svg.classList.add("cm-mermaid-svg");

  const key = mermaidSourceKey(opts.code);
  let lastPercent = 100;
  let controller: ZoomPanController | null = null;
  let expandClose: (() => void) | null = null;
  let destroyed = false;

  const capHeight = (): number =>
    Math.max(
      MIN_VIEWPORT_PX,
      Math.min(
        MAX_VIEWPORT_PX,
        Math.round(opts.view.scrollDOM.clientHeight * VIEWPORT_FRACTION),
      ),
    );

  /** Size the viewport and the SVG's untransformed box, then hand the box to the
   *  controller. The viewport is exactly as tall as the diagram needs up to the
   *  cap, so a small diagram leaves no dead space and a tall one is bounded. */
  const measure = (): ContentBox | null => {
    const stageW = viewport.clientWidth;
    if (stageW <= 0) return null;
    const atWidthHeight = natural.h * (stageW / natural.w);
    const stageH = Math.max(1, Math.min(capHeight(), atWidthHeight));
    viewport.style.height = `${Math.round(stageH)}px`;
    const ratio = Math.min(stageW / natural.w, stageH / natural.h);
    const fitW = natural.w * ratio;
    const fitH = natural.h * ratio;
    svg.style.width = `${fitW}px`;
    svg.style.height = `${fitH}px`;
    svg.style.maxWidth = "none";
    return { fitW, fitH, naturalW: natural.w };
  };

  const remeasureHost = () => {
    try {
      opts.view.requestMeasure();
    } catch {
      /* view torn down before the render settled */
    }
  };

  const openExpand = () => {
    if (expandClose !== null) return;
    controller?.destroy();
    controller = null;

    // Expanded is the ACTIVE EDITOR turned into the diagram, not a modal floating
    // over the app: the surface is pinned to the editor's own rect, so the tab,
    // the sidebar and the status bar stay exactly where they were. `position:
    // fixed` plus that rect is deliberate: it needs no `position: relative` on a
    // CodeMirror ancestor, which would be a layout change to a surface this
    // feature does not own.
    const overlay = document.createElement("div");
    overlay.className = "cm-mermaid-expand";
    overlay.tabIndex = -1;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", i18n.t("editor.mermaid.viewerLabel"));
    const place = () => {
      const r = editorSlotRect(opts.view);
      overlay.style.top = `${r.top}px`;
      overlay.style.left = `${r.left}px`;
      overlay.style.width = `${r.width}px`;
      overlay.style.height = `${r.height}px`;
    };
    place();
    document.body.appendChild(overlay);

    const stage = document.createElement("div");
    stage.className = "cm-mermaid-expand-stage";
    stage.tabIndex = 0;
    overlay.appendChild(stage);
    stage.appendChild(svg);

    const chrome = document.createElement("div");
    chrome.className = "cm-mermaid-chrome-bar";
    chrome.append(
      chromeButton(
        "editor.mermaid.edit",
        i18n.t("editor.mermaid.edit"),
        i18n.t("editor.mermaid.editText"),
        "pencil",
        opts.onEdit,
      ),
      chromeButton(
        "editor.mermaid.expand-close",
        i18n.t("editor.mermaid.expandClose"),
        i18n.t("editor.mermaid.expandCloseText"),
        "x",
        () => closeExpand(),
      ),
    );
    overlay.appendChild(chrome);

    let expandController: ZoomPanController | null = null;
    const grid = buildGrid(() => expandController);
    overlay.appendChild(grid);
    expandController = mountZoom({
      stage,
      element: svg,
      measure: () => {
        const stageW = stage.clientWidth;
        const stageH = stage.clientHeight;
        if (stageW <= 0 || stageH <= 0) return null;
        const ratio = Math.min(stageW / natural.w, stageH / natural.h);
        const fitW = natural.w * ratio;
        const fitH = natural.h * ratio;
        svg.style.width = `${fitW}px`;
        svg.style.height = `${fitH}px`;
        svg.style.maxWidth = "none";
        return { fitW, fitH, naturalW: natural.w };
      },
      rest: "width",
      wheel: "modifier",
      doubleClick: false,
      keyboard: true,
      ready: true,
      panTarget: stage,
    });
    expandController.setPercent(lastPercent);

    // Esc closes, and the editor rect is re-read while the window changes size.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeExpand();
      }
    };
    overlay.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", place);
    stage.focus();

    expandClose = () => {
      if (expandClose === null) return;
      expandClose = null;
      overlay.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", place);
      expandController?.destroy();
      expandController = null;
      viewport.appendChild(svg);
      overlay.remove();
      if (!destroyed) {
        controller = mountInline();
        remeasureHost();
      }
    };
  };

  const closeExpand = () => expandClose?.();

  const mountInline = (): ZoomPanController =>
    mountZoom({
      stage: viewport,
      element: svg,
      measure,
      rest: "width",
      wheel: "modifier",
      doubleClick: false,
      keyboard: true,
      ready: true,
      panTarget: viewport,
      onPercent: (pct) => {
        lastPercent = pct;
      },
      onCommit: () => {
        mermaidZoomStore.set(key, lastPercent);
        remeasureHost();
      },
    });

  // Top-right chrome: Edit (icon plus word), then Expand.
  const chromeBar = document.createElement("div");
  chromeBar.className = "cm-mermaid-chrome-bar";
  chromeBar.append(
    chromeButton(
      "editor.mermaid.edit",
      i18n.t("editor.mermaid.edit"),
      i18n.t("editor.mermaid.editText"),
      "pencil",
      opts.onEdit,
    ),
    chromeButton(
      "editor.mermaid.expand",
      i18n.t("editor.mermaid.expand"),
      i18n.t("editor.mermaid.expandText"),
      "maximize",
      openExpand,
    ),
  );
  frame.appendChild(chromeBar);
  frame.appendChild(buildGrid(() => controller));

  controller = mountInline();
  // Restore a scale remembered from an earlier mount of the same diagram. The
  // store is cleared when the vault leaves, so this never crosses vaults.
  const remembered = mermaidZoomStore.get(key);
  if (remembered !== undefined && remembered !== lastPercent) {
    controller.setPercent(remembered);
  }

  // Double-click edits, matching the chrome's Edit button. Registered on the
  // viewport so it works anywhere on the diagram.
  viewport.addEventListener("dblclick", (e) => {
    e.preventDefault();
    opts.onEdit();
  });

  return {
    destroy() {
      destroyed = true;
      controller?.destroy();
      controller = null;
      const close = expandClose;
      expandClose = null;
      close?.();
    },
    remeasure() {
      controller?.remeasure();
    },
  };
}
