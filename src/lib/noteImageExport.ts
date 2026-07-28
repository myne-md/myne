// MYND-361 note→image: the RUNTIME orchestrator that turns the current editor
// selection into a shareable PNG card and writes it to a user-chosen path.
//
// Pipeline (the pure step 2 — the SVG card — lives in `noteImageCard.ts`):
//   1. serialize the rendered selection to XHTML + measure it — RUNTIME (live
//      DOM via `window.getSelection()` + `XMLSerializer`);
//   2. wrap it in the padded, theme-backed `<svg>` card — pure (`noteImageCard`);
//   3. draw the SVG to an offscreen `<canvas>` and encode PNG — RUNTIME (WebView
//      canvas: `Image` decode → `drawImage` → `toBlob`);
//   4. save dialog → `note_image_export` writes the bytes (atomic, at the user
//      destination) — IPC.
//
// Zero rasterization dependency (html2canvas / dom-to-image rejected — the
// reproducible-build + audit-surface commitment). Steps 1 + 3 are the pieces
// only a running WebView can verify — flagged for dev-server QA. WKWebView
// (macOS) renders `<foreignObject>`-in-SVG-to-canvas less reliably than
// Chromium; if a platform taints the canvas, `toBlob` yields null and the
// export surfaces a coarse "error" outcome rather than a broken file.

import { save } from "../platform/dialog";
import { invoke } from "../platform/core";
import { has } from "../platform/capabilities";
import { deliverFile } from "../platform/download";
import {
  buildSelectionCardSvg,
  svgToObjectUrl,
  type ShareCardOptions,
} from "./noteImageCard";
import { getActiveEditorView } from "../editor/active-view";

/** Card breathing room (px) around the rendered selection. */
export const SELECTION_CARD_PADDING = 32;
/** Raster supersampling for crisp text on hi-DPI displays. */
const RASTER_SCALE = 2;

/** The coarse, non-throwing outcome of an export attempt (drives a toast). */
export type ImageExportOutcome = "ok" | "no-selection" | "cancelled" | "error";

/** The measured, serialized selection. */
export interface SerializedSelection {
  xhtml: string;
  width: number;
  height: number;
}

/**
 * Serialize the current window selection to well-formed XHTML + its measured
 * bounding size. `null` when there is no non-empty, non-zero-area selection.
 * RUNTIME (needs the live DOM). The cloned nodes carry the editor's rendered
 * markup (chips, formatting); per-node computed-style inlining is intentionally
 * NOT done — the card leans on the wrapper font + theme background, keeping the
 * step dependency-free (full style inlining is the QA-flagged refinement).
 */
/**
 * Serialize the ACTIVE EDITOR's selection — read from the CM view STATE, not the
 * live DOM selection. This is the reliable path when the editor is blurred (e.g.
 * the command palette has focus, so `window.getSelection()` reflects the palette
 * input and reads empty — the "select text first" bug). The DOM range is rebuilt
 * from `view.domAtPos`, so the rendered markup + measured size still come from
 * the on-screen selection. `null` when no editor is active or the selection is
 * empty / zero-area.
 */
export function serializeEditorSelection(): SerializedSelection | null {
  const view = getActiveEditorView();
  if (view === null) return null;
  const { from, to } = view.state.selection.main;
  if (from === to) return null;
  let range: Range;
  try {
    const start = view.domAtPos(from);
    const end = view.domAtPos(to);
    range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null; // positions not in the rendered DOM (out of viewport)
  }
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const wrapper = document.createElement("div");
  wrapper.appendChild(range.cloneContents());
  let xhtml: string;
  try {
    xhtml = new XMLSerializer().serializeToString(wrapper);
  } catch {
    return null;
  }
  return {
    xhtml,
    width: Math.max(1, Math.ceil(rect.width)),
    height: Math.max(1, Math.ceil(rect.height)),
  };
}

export function serializeSelection(): SerializedSelection | null {
  const sel = window.getSelection();
  if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const wrapper = document.createElement("div");
  wrapper.appendChild(range.cloneContents());
  let xhtml: string;
  try {
    xhtml = new XMLSerializer().serializeToString(wrapper);
  } catch {
    return null; // non-serializable DOM — abort rather than emit malformed SVG
  }
  return {
    xhtml,
    width: Math.max(1, Math.ceil(rect.width)),
    height: Math.max(1, Math.ceil(rect.height)),
  };
}

/**
 * Rasterize an SVG card to PNG bytes via an offscreen canvas. `cardWidth` /
 * `cardHeight` are the FULL card dimensions (content + padding). RUNTIME
 * (WebView canvas). Rejects on image-load / draw / encode failure or a tainted
 * canvas (`toBlob` → null).
 */
export async function rasterizeCardToPng(
  svg: string,
  cardWidth: number,
  cardHeight: number,
  scale: number = RASTER_SCALE,
): Promise<Uint8Array> {
  const img = new Image();
  img.width = cardWidth;
  img.height = cardHeight;
  // Revoked in `finally`, not after `onload`: the decode can also FAIL, and an
  // object URL that outlives its use pins the SVG for the life of the page.
  const src = svgToObjectUrl(svg);
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("card image failed to decode"));
      img.src = src;
    });
  } finally {
    URL.revokeObjectURL(src);
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cardWidth * scale);
  canvas.height = Math.round(cardHeight * scale);
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("no 2d canvas context");
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, cardWidth, cardHeight);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (blob === null) throw new Error("canvas.toBlob returned null (tainted canvas?)");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Read a CSS custom property off `:root`, falling back to `fallback`. */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v !== "" ? v : fallback;
}

/**
 * End-to-end selection→image export: serialize → card → PNG → save dialog →
 * write. Never throws — returns a coarse {@link ImageExportOutcome} the caller
 * turns into a toast. The card background + font come from the ACTIVE theme
 * (per the grill: the syntax/theme colours are not separately editable), read
 * from the design-token CSS variables at call time.
 */
export async function exportSelectionAsImage(): Promise<ImageExportOutcome> {
  // Prefer the CM view-state selection (survives the editor being blurred by the
  // command palette); fall back to the live DOM selection (e.g. invoked from the
  // floating toolbar while the editor is focused, or no editor registered).
  const selection = serializeEditorSelection() ?? serializeSelection();
  if (selection === null) return "no-selection";

  let bytes: Uint8Array;
  try {
    const opts: ShareCardOptions = {
      contentWidth: selection.width,
      contentHeight: selection.height,
      padding: SELECTION_CARD_PADDING,
      background: cssVar("--paper-1", "#faf8f3"),
      fontFamily: cssVar("--font-sans", "sans-serif"),
    };
    const svg = buildSelectionCardSvg(selection.xhtml, opts);
    bytes = await rasterizeCardToPng(
      svg,
      selection.width + SELECTION_CARD_PADDING * 2,
      selection.height + SELECTION_CARD_PADDING * 2,
    );
  } catch {
    return "error";
  }

  // The download arm (phase3-web-client tasks 48 + 97). Nothing about the
  // pipeline above changes: steps 1–3 are WebView work on both platforms and the
  // bytes are already a finished PNG. Only the last step differs — a platform
  // with no `nativeSaveAs` hands them to the browser's download instead of to
  // Rust with a path.
  //
  // No egress-disclosure step here, and that is a deliberate match to desktop
  // rather than an omission: this flow has no sanctioned sentence on either
  // platform. The reason it does not need one is that the action names its own
  // output — the user selected specific content and chose "export selection as
  // image", so what leaves is exactly what they pointed at, not a whole note or
  // a whole vault whose contents they may not have in mind. If that judgement is
  // ever revised it is a `design-notes.md` event and applies to BOTH clients;
  // it must not become a web-only sentence invented inside an export flow.
  if (!has("nativeSaveAs")) {
    try {
      await deliverFile("myne-selection.png", bytes, "image/png");
      return "ok";
    } catch {
      return "error";
    }
  }

  let targetPath: string | null;
  try {
    targetPath = await save({
      defaultPath: "myne-selection.png",
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
  } catch {
    return "error";
  }
  if (targetPath === null) return "cancelled"; // user dismissed the dialog

  try {
    await invoke("plugin:notes|note_image_export", {
      // A plain number array deserializes into the Rust `Vec<u8>` arg. A shared
      // note-selection card is small (KBs), so the JSON-array transit is fine.
      imageBytes: Array.from(bytes),
      targetPath,
      // The OS save dialog already collected the user's replace consent when
      // they chose an existing filename, so honor it (SYNC-2).
      overwrite: true,
    });
    return "ok";
  } catch {
    return "error";
  }
}
