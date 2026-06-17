// Lazy Mermaid diagram renderer (MYND-49, mermaid-diagrams).
//
// Dynamic `import()` → Mermaid (the epic's heaviest dependency) is code-split
// out of the cold editor bundle (SYNC-4); a diagram-free note pays zero bytes.
// `securityLevel: 'strict'` + `htmlLabels: false` (SYNC-5 vetted-output) so
// Mermaid sanitizes its own SVG (it bundles DOMPurify internally). `mermaid.render`
// is async; errors are RETURNED, not thrown, so the decoration falls back to the
// monospace code card (the pdfjs generic-fallback precedent).
//
// NOTE: Mermaid's actual SVG render requires a real browser layout engine
// (`getBBox`, etc.) that jsdom does not implement, so it is exercised at runtime
// (`pnpm tauri dev`), not in unit tests. The lazy-load contract + the
// error/fallback path ARE unit-tested via `setMermaidLoader`.

export interface MermaidRenderResult {
  readonly svg: string;
  readonly error: string | null;
}

export type MermaidRenderer = (
  id: string,
  code: string,
) => Promise<MermaidRenderResult>;

type Loader = () => Promise<MermaidRenderer>;

let load: Loader = async () => {
  const mermaidMod = await import("mermaid");
  const mermaid = mermaidMod.default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict", // sanitize + no click/script in diagrams
    htmlLabels: false, // no raw-HTML labels
    fontFamily: "inherit",
    // The diagram renders on a fixed-light card (`.cm-mermaid-card`, theme.ts;
    // and the export's `.mermaid-diagram`, print-stylesheet.ts) so it reads on
    // either editor theme AND in the light HTML/PDF export. We pin the FULL light
    // node palette (not just edge/text colors) in Myne tokens: relying on
    // mermaid's class-based `<style>` fills alone left flowchart nodes rendering
    // as the SVG default (black `fill`) in the standalone export — explicit
    // `mainBkg`/`primaryColor`/border/text values bake a visible light fill into
    // every node class so a flowchart reads identically in-editor and in export.
    theme: "default",
    themeVariables: {
      fontFamily: "inherit",
      background: "#fbfbfa",
      edgeLabelBackground: "#fbfbfa",
      textColor: "#1a1a17",
      lineColor: "#6b6a64",
      // Node fills + borders + label text (flowchart / class / state / ER …).
      mainBkg: "#eef0f4",
      primaryColor: "#eef0f4",
      primaryBorderColor: "#c8c7c1",
      primaryTextColor: "#1a1a17",
      secondaryColor: "#e6eaf0",
      secondaryBorderColor: "#c8c7c1",
      secondaryTextColor: "#1a1a17",
      tertiaryColor: "#f0f1f4",
      tertiaryBorderColor: "#c8c7c1",
      tertiaryTextColor: "#1a1a17",
      nodeBorder: "#c8c7c1",
      nodeTextColor: "#1a1a17",
      titleColor: "#1a1a17",
      clusterBkg: "#f4f4f2",
      clusterBorder: "#e3e2dd",
    },
  });
  return async (id, code) => {
    try {
      const { svg } = await mermaid.render(id, code);
      return { svg, error: null };
    } catch (e) {
      return { svg: "", error: e instanceof Error ? e.message : String(e) };
    }
  };
};

let rendererPromise: Promise<MermaidRenderer> | null = null;

/** Override the Mermaid loader (tests only); returns a restore fn. */
export function setMermaidLoader(loader: Loader): () => void {
  const prev = load;
  load = loader;
  rendererPromise = null;
  return () => {
    load = prev;
    rendererPromise = null;
  };
}

/** Lazy-load the Mermaid renderer once (cached promise). */
export function loadMermaidRenderer(): Promise<MermaidRenderer> {
  if (rendererPromise === null) rendererPromise = load();
  return rendererPromise;
}
