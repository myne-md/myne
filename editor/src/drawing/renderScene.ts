// Offline scene → PNG/SVG renderer (drawing-notes SF4, MYND-501; SYNC-3/9).
//
// The SINGLE shared render capability: SF4 export, SF2 tab/sidebar thumbnail, and
// SF6 inline embed all call this — never a second renderer (SYNC-3). Uses
// Excalidraw's own `exportToBlob`/`exportToSvg` with fonts already self-hosted
// (SF1), so no network. Lives in the lazy Excalidraw chunk (imports the library),
// so callers reach it via a dynamic import, never a cold-bundle import.
//
// RUNTIME NOTE: `exportToBlob` rasterizes on an offscreen canvas — it cannot run
// under jsdom, so this is verified live, not headlessly. Build-green + correct-
// by-construction against the documented API.
import { exportToBlob, exportToSvg } from "@excalidraw/excalidraw";

export type RenderFormat = "png" | "svg";
export type RenderOptions = {
  format?: RenderFormat;
  /** Raster scale for PNG (retina default 2×). Ignored for SVG. */
  scale?: number;
  /** Transparent by default; pass a CSS color for an opaque background. */
  background?: string | null;
  /**
   * Render with Excalidraw's dark-mode transform so the export matches how the
   * editor paints the scene (a scene drawn in dark mode stores dark stroke
   * colors that the editor inverts on display; without this the export shows the
   * raw dark strokes — a faint, near-invisible thumbnail, #213 review). The
   * CALLER supplies this from the live app theme because a scene that matches the
   * app default is stored themeless, so the scene JSON alone can't tell us.
   * Falls back to the scene's persisted theme.
   */
  darkMode?: boolean;
};

type Scene = {
  elements?: unknown;
  appState?: Record<string, unknown>;
  files?: unknown;
};

function parseScene(sceneJson: string): Scene | null {
  try {
    return JSON.parse(sceneJson) as Scene;
  } catch {
    return null;
  }
}

/** Excalidraw's own dark-mode DISPLAY filter (`THEME_FILTER`). We apply it as a
 *  post-process (`applyThemeFilter`) rather than via `appState.exportWithDarkMode`
 *  because that export flag is unreliable on this path (0.18.1) — the raw export
 *  came back with un-inverted strokes. This is the exact transform the editor
 *  paints the canvas with, so a filtered thumbnail matches the editor pixel-wise
 *  (default "white" strokes → white; custom colours shift the same way they do
 *  on-canvas). Transparent stays transparent (the filter touches RGB, not alpha),
 *  so the dark backdrop is the body behind it, never a baked white. */
const THEME_FILTER = "invert(93%) hue-rotate(180deg)";

/** Render a drawing scene to a PNG `Blob`. Returns null on a malformed scene.
 *  Always renders in the scene's RAW colours; dark-mode matching is the data-URI
 *  post-filter (`renderSceneDataUri` with `darkMode`). */
export async function renderScenePng(
  sceneJson: string,
  opts: RenderOptions = {},
): Promise<Blob | null> {
  const scene = parseScene(sceneJson);
  if (scene === null) return null;
  const appState = {
    ...(scene.appState ?? {}),
    exportBackground: opts.background != null,
    viewBackgroundColor: opts.background ?? "transparent",
  };
  return await exportToBlob({
    elements: (scene.elements ?? []) as never,
    appState: appState as never,
    files: (scene.files ?? {}) as never,
    mimeType: "image/png",
    exportPadding: 8,
    getDimensions: (w: number, h: number) => {
      const s = opts.scale ?? 2;
      return { width: w * s, height: h * s, scale: s };
    },
  });
}

/** Render a drawing scene to an SVG `SVGSVGElement`. Null on a malformed scene. */
export async function renderSceneSvg(
  sceneJson: string,
  opts: RenderOptions = {},
): Promise<SVGSVGElement | null> {
  const scene = parseScene(sceneJson);
  if (scene === null) return null;
  const appState = {
    ...(scene.appState ?? {}),
    exportBackground: opts.background != null,
    viewBackgroundColor: opts.background ?? "transparent",
  };
  return await exportToSvg({
    elements: (scene.elements ?? []) as never,
    appState: appState as never,
    files: (scene.files ?? {}) as never,
    exportPadding: 8,
  });
}

function blobToDataUri(blob: Blob): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/** Re-draw a PNG data URI through Excalidraw's dark DISPLAY filter, so the result
 *  looks exactly like the dark editor (default strokes → white; custom colours
 *  shifted the same way; transparent pixels stay transparent → a dark backdrop
 *  behind it stays dark). Returns the original URI unchanged if a canvas is not
 *  available (no-op fallback). */
function applyThemeFilter(dataUri: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (ctx === null) {
          resolve(dataUri);
          return;
        }
        ctx.filter = THEME_FILTER;
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(dataUri);
      }
    };
    img.onerror = () => resolve(dataUri);
    img.src = dataUri;
  });
}

/** A `data:` URI PNG for in-app surfaces (thumbnail, inline embed, HTML/PDF
 *  export projection). Null on a malformed scene / render failure. With
 *  `darkMode`, the raw render is passed through Excalidraw's dark display filter
 *  so it matches the dark editor. */
export async function renderSceneDataUri(
  sceneJson: string,
  opts: RenderOptions = {},
): Promise<string | null> {
  const blob = await renderScenePng(sceneJson, opts);
  if (blob === null) return null;
  const uri = await blobToDataUri(blob);
  if (uri === null) return null;
  return opts.darkMode === true ? await applyThemeFilter(uri) : uri;
}
