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
    // The diagram follows the ACTIVE THEME (myne-md/myne#708 follow-up). The
    // card, the chrome and mermaid's own palette all bind to Myne tokens, so a
    // dark or AMOLED theme gets a dark diagram instead of a white panel. This
    // supersedes the fixed-light clause of decision 0566, whose whole reason was
    // that mermaid's palette was pinned light while the surface was not: with
    // both sides on tokens the drift it guarded against cannot happen. The values
    // are `var(...)`, which mermaid emits verbatim into its `<style>` block, so
    // they resolve against the editor's `:root` at paint time.
    theme: "default",
    themeVariables: {
      fontFamily: "var(--font-sans)",
      background: "var(--paper)",
      edgeLabelBackground: "var(--paper)",
      textColor: "var(--ink-1)",
      lineColor: "var(--ink-2)",
      // Node fills + borders + label text (flowchart / class / state / ER …).
      mainBkg: "var(--paper-2)",
      primaryColor: "var(--paper-2)",
      primaryBorderColor: "var(--line-2)",
      primaryTextColor: "var(--ink-1)",
      secondaryColor: "var(--paper-3)",
      secondaryBorderColor: "var(--line-2)",
      secondaryTextColor: "var(--ink-1)",
      tertiaryColor: "var(--paper-2)",
      tertiaryBorderColor: "var(--line-2)",
      tertiaryTextColor: "var(--ink-1)",
      nodeBorder: "var(--line-2)",
      nodeTextColor: "var(--ink-1)",
      titleColor: "var(--ink-1)",
      clusterBkg: "var(--paper-2)",
      clusterBorder: "var(--line-1)",
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
