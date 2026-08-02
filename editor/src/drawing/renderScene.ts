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

/** Whether to apply the dark-mode transform: explicit caller flag, else the
 *  scene's persisted theme. */
function useDarkMode(scene: Scene, opts: RenderOptions): boolean {
  if (opts.darkMode !== undefined) return opts.darkMode;
  return scene.appState?.theme === "dark";
}

/** Render a drawing scene to a PNG `Blob`. Returns null on a malformed scene. */
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
    exportWithDarkMode: useDarkMode(scene, opts),
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
    exportWithDarkMode: useDarkMode(scene, opts),
  };
  return await exportToSvg({
    elements: (scene.elements ?? []) as never,
    appState: appState as never,
    files: (scene.files ?? {}) as never,
    exportPadding: 8,
  });
}

/** A `data:` URI PNG for in-app surfaces (thumbnail, inline embed, HTML/PDF
 *  export projection). Null on a malformed scene / render failure. */
export async function renderSceneDataUri(
  sceneJson: string,
  opts: RenderOptions = {},
): Promise<string | null> {
  const blob = await renderScenePng(sceneJson, opts);
  if (blob === null) return null;
  return await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}
