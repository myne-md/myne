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

/** Whether the document is wearing a dark theme. Each client's theme layer
 *  applies `data-theme` on `:root`; absent means light. */
function isDarkTheme(): boolean {
  if (typeof document === "undefined") return false;
  const theme = document.documentElement.dataset.theme;
  return theme === "dark" || theme === "amoled";
}

let load: Loader = async () => {
  const mermaidMod = await import("mermaid");
  const mermaid = mermaidMod.default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict", // sanitize + no click/script in diagrams
    htmlLabels: false, // no raw-HTML labels
    // NOT `inherit` (myne-md/myne#629). `mermaid.render(id, code)` is called
    // with no container, and in that branch mermaid appends its temp div to
    // `document.body` and passes it NO font-family. The container branch four
    // lines above it in mermaid's own source does pass one. So `inherit`
    // resolved against `document.body` (--font-sans at --text-base) while the
    // finished SVG is displayed inside `.cm-editor` (--editor-font-family, mono
    // by default, at --editor-text-size). Every `getBBox()` in the dagre layout
    // was therefore taken against a font the diagram is never drawn in, and the
    // labels overran the boxes measured for them. A `:root` custom property has
    // one value in every context in the document, so naming the token directly
    // makes measurement and display agree by construction rather than by both
    // happening to sit under the same ancestor.
    fontFamily: "var(--font-sans)",
    // The diagram follows the ACTIVE THEME (myne-md/myne#708 follow-up). This
    // supersedes the fixed-light clause of decision 0566, whose whole reason was
    // that mermaid's palette was pinned light while the surface was not.
    //
    // NOT `var(--token)` values: mermaid feeds these through its colour library
    // to derive the rest of the palette, and a `var()` is not a colour it can
    // parse, so the render throws and the block falls back to raw source. The
    // palette is therefore chosen here, at initialize time, from the theme the
    // document is actually wearing. A theme switch mid-session is picked up on
    // the next WebView reload rather than re-initialising mermaid per render.
    theme: isDarkTheme() ? "dark" : "default",
    themeVariables: isDarkTheme()
      ? { fontFamily: "var(--font-sans)" }
      : {
          fontFamily: "var(--font-sans)",
          // The light node palette is pinned (not just edge/text colors):
          // relying on mermaid's class-based `<style>` fills alone left flowchart
          // nodes rendering as the SVG default (black `fill`) in the standalone
          // export, so explicit fills bake a visible light fill into every node
          // class and a flowchart reads identically in-editor and in export.
          background: "#fbfbfa",
          edgeLabelBackground: "#fbfbfa",
          textColor: "#1a1a17",
          lineColor: "#6b6a64",
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
