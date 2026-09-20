// Bounded, interactive viewer for a rendered mermaid diagram (myne-md/myne#708).
//
// Mermaid draws the SVG at its natural size and the widget used to show it as a
// static card: horizontal scroll only, the vertical axis unbounded, and every
// `mousedown` dropped back to source so a drag could never start. This wraps the
// SVG in a clipping viewport, fits it to the column, and drives the SHARED
// pan/zoom controller (`attachments/image-zoom-controller.ts`) from an
// always-visible control bar.
//
// Render-only, and the mechanism is what keeps that true: zoom and pan are a CSS
// `transform` on the LIVE SVG node already in the DOM. Nothing is re-parsed,
// nothing is re-serialised, and no second `innerHTML` sink is added, so
// `docs/threat-model.md` §7's "mermaid sanitizes its own output and that is what
// is injected" stays literally true. The note's bytes are never touched.
//
// Everything is shared by desktop, web and mobile: the control bar is
// always-visible rather than hover-revealed because the mobile WebView has no
// hover, and the controller carries the pinch path for touch.

import type { EditorView } from "@codemirror/view";
import i18n from "@myne/editor/i18n";
import { openModal } from "@myne/editor/host/lib/imperative-modal";
import {
  mountZoom,
  type ContentBox,
  type ZoomPanController,
} from "../attachments/image-zoom-controller";
import { mermaidZoomStore } from "../attachments/session-caches";

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

/** One control-bar button. `stopPropagation` keeps the press off the stage, so
 *  a click on a control never starts a pan. */
function controlButton(
  testid: string,
  label: string,
  glyph: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-mermaid-control";
  button.setAttribute("data-testid", testid);
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = glyph;
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return button;
}

interface Controls {
  readonly el: HTMLDivElement;
  setPercent(pct: number): void;
}

/** The GitHub-shaped control bar: zoom out / percentage-reset / zoom in, the
 *  four pan arrows, edit source and expand. */
function buildControls(
  getController: () => ZoomPanController | null,
  onEdit: () => void,
  onExpand: () => void,
): Controls {
  const el = document.createElement("div");
  el.className = "cm-mermaid-controls";
  const zoomOut = controlButton(
    "editor.mermaid.zoom-out",
    i18n.t("editor.mermaid.zoomOut"),
    "\u2212",
    () => getController()?.zoomOut(),
  );
  const percent = document.createElement("button");
  percent.type = "button";
  percent.className = "cm-mermaid-control cm-mermaid-percent";
  percent.setAttribute("data-testid", "editor.mermaid.reset");
  percent.setAttribute("aria-label", i18n.t("editor.mermaid.reset"));
  percent.setAttribute("aria-live", "polite");
  percent.addEventListener("click", (e) => {
    e.stopPropagation();
    getController()?.reset();
  });
  const zoomIn = controlButton(
    "editor.mermaid.zoom-in",
    i18n.t("editor.mermaid.zoomIn"),
    "+",
    () => getController()?.zoomIn(),
  );
  const panUp = controlButton(
    "editor.mermaid.pan-up",
    i18n.t("editor.mermaid.panUp"),
    "\u2191",
    () => getController()?.pan(0, PAN_STEP),
  );
  const panDown = controlButton(
    "editor.mermaid.pan-down",
    i18n.t("editor.mermaid.panDown"),
    "\u2193",
    () => getController()?.pan(0, -PAN_STEP),
  );
  const panLeft = controlButton(
    "editor.mermaid.pan-left",
    i18n.t("editor.mermaid.panLeft"),
    "\u2190",
    () => getController()?.pan(PAN_STEP, 0),
  );
  const panRight = controlButton(
    "editor.mermaid.pan-right",
    i18n.t("editor.mermaid.panRight"),
    "\u2192",
    () => getController()?.pan(-PAN_STEP, 0),
  );
  const edit = controlButton(
    "editor.mermaid.edit",
    i18n.t("editor.mermaid.edit"),
    i18n.t("editor.mermaid.editGlyph"),
    onEdit,
  );
  const expand = controlButton(
    "editor.mermaid.expand",
    i18n.t("editor.mermaid.expand"),
    "\u26F6",
    onExpand,
  );
  el.append(
    zoomOut,
    percent,
    zoomIn,
    panUp,
    panDown,
    panLeft,
    panRight,
    edit,
    expand,
  );
  return {
    el,
    setPercent(pct) {
      percent.textContent = `${pct}%`;
    },
  };
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

  const viewport = document.createElement("div");
  viewport.className = "cm-mermaid-viewport";
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "group");
  viewport.setAttribute("aria-label", i18n.t("editor.mermaid.viewerLabel"));
  // The frame is the positioning context for the control bar, so the bar is a
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

    const host = openModal({
      backdropClass: "cm-mermaid-expand",
      onDismiss: () => closeExpand(),
    });
    const backdrop = host.backdrop;
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-label", i18n.t("editor.mermaid.viewerLabel"));
    const stage = document.createElement("div");
    stage.className = "cm-mermaid-expand-stage";
    backdrop.appendChild(stage);
    stage.appendChild(svg);

    let expandController: ZoomPanController | null = null;
    const expandControls = buildControls(
      () => expandController,
      opts.onEdit,
      () => closeExpand(),
    );
    backdrop.appendChild(expandControls.el);
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
      onPercent: expandControls.setPercent,
    });
    expandController.setPercent(lastPercent);
    host.installTrap(backdrop, expandControls.el);

    expandClose = () => {
      if (expandClose === null) return;
      expandClose = null;
      expandController?.destroy();
      expandController = null;
      viewport.appendChild(svg);
      host.close();
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
        controls.setPercent(pct);
      },
      onCommit: () => {
        mermaidZoomStore.set(key, lastPercent);
        remeasureHost();
      },
    });

  const controls = buildControls(() => controller, opts.onEdit, openExpand);
  frame.appendChild(controls.el);

  controller = mountInline();
  // Restore a scale remembered from an earlier mount of the same diagram. The
  // store is cleared when the vault leaves, so this never crosses vaults.
  const remembered = mermaidZoomStore.get(key);
  if (remembered !== undefined && remembered !== lastPercent) {
    controller.setPercent(remembered);
  }

  // Double-click edits, matching the control bar's edit button. Registered on
  // the viewport so it works anywhere on the diagram.
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
