// Lazy KaTeX math renderer (MYND-48, math-katex).
//
// Dynamic `import()` → KaTeX is code-split out of the cold editor bundle (SYNC-4);
// a math-free note pays zero bytes. The KaTeX CSS + self-hosted fonts load
// alongside (Vite bundles the fonts from `node_modules/katex/dist/fonts` — no
// CDN, reproducible-build-safe; CSP needs no relaxation). Errors are RETURNED,
// not thrown, so the decoration can fall back to raw source + a subtle indicator
// (the grill's invalid-LaTeX UX, MYND-48 Q2).

export interface MathRenderResult {
  readonly html: string;
  readonly error: string | null;
}

export type MathRenderer = (
  latex: string,
  displayMode: boolean,
) => MathRenderResult;

type Loader = () => Promise<MathRenderer>;

let load: Loader = async () => {
  const katexMod = await import("katex");
  // Self-hosted CSS + fonts. Vite bundles them; vitest no-ops the CSS import.
  await import("katex/dist/katex.min.css").catch(() => undefined);
  const katex = katexMod.default;
  return (latex, displayMode) => {
    try {
      const html = katex.renderToString(latex, {
        displayMode,
        throwOnError: true, // we catch + return so we control the fallback
        // Stays `html` (myne-md/myne#728 considered `htmlAndMathml` and did
        // not take it). KaTeX's MathML branch embeds the raw LaTeX source in
        // an `<annotation>` element, which is inert text but which puts the
        // literal strings `javascript:` and `data:text/html` into the rendered
        // output for a hostile `\href{...}`. Nothing executes, and no anchor
        // is produced (`trust` is off), but making that true would mean
        // narrowing `tests/editor/math-trust.test.ts` from "no executable
        // scheme appears anywhere in the output" to "none appears in an
        // attribute", which is a weaker assertion on the one surface where note
        // content reaches the DOM through `innerHTML`. The accessibility the
        // MathML branch would have bought is bought instead at the widget
        // (`decorations/math.ts`: `role="math"` named by the LaTeX source,
        // with the visual layout hidden), which touches no sanitization
        // surface. Revisit deliberately, with the threat model open, not as a
        // side effect of an options tidy-up.
        output: "html",
      });
      return { html, error: null };
    } catch (e) {
      return { html: "", error: e instanceof Error ? e.message : String(e) };
    }
  };
};

let rendererPromise: Promise<MathRenderer> | null = null;

/** Override the KaTeX loader (tests only); returns a restore fn. */
export function setMathRendererLoader(loader: Loader): () => void {
  const prev = load;
  load = loader;
  rendererPromise = null;
  return () => {
    load = prev;
    rendererPromise = null;
  };
}

/** Lazy-load the KaTeX renderer once (cached promise). */
export function loadMathRenderer(): Promise<MathRenderer> {
  if (rendererPromise === null) rendererPromise = load();
  return rendererPromise;
}
