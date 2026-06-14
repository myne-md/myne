// Lazy heavy-renderer loading for the HTML projection emitter (MYND-255).
//
// SYNC-4 lazy-load discipline (docs/dependency-policy.md): every heavy
// dependency stays a dynamic `import()` — KaTeX, mermaid, and DOMPurify reach
// this module ONLY through the editor's existing lazy loaders
// (`render-math.ts` / `render-mermaid.ts` / `sanitize.ts`), so their test
// override hooks (`setMathRendererLoader` etc.) govern the emitter too, and a
// note without the construct pays zero bytes. The code-highlight languages
// (`code-languages.ts`, eager in the editor bundle by its own decision) and
// `@lezer/highlight` are also dynamic here so the emitter itself adds nothing
// to any cold path.
//
// Mermaid requires a real browser layout engine (`getBBox` — see
// render-mermaid.ts); in jsdom/node the emitter NEVER attempts a render and
// falls back to the monospace code card. Real-SVG output is exercised in the
// app/capture path (the hidden export window), not in unit tests.

import { loadMathRenderer, type MathRenderer } from "../../editor/math/render-math";
import {
  loadMermaidRenderer,
  type MermaidRenderer,
} from "../../editor/mermaid/render-mermaid";
import { loadPurifier, type Purifier } from "../../editor/html/sanitize";
import { escapeHtml } from "./escape";

/** Sync code highlighter: spans tagged with `@lezer/highlight` classHighlighter
 *  classes (`tok-keyword`, `tok-string`, …) or `null` for an unknown language. */
export type CodeHighlighter = (code: string, info: string) => string | null;

export interface HeavyRenderers {
  readonly math: MathRenderer | null;
  readonly highlight: CodeHighlighter | null;
  readonly purifier: Purifier | null;
  readonly emoji: Readonly<Record<string, string>> | null;
  readonly mermaid: MermaidRenderer | null;
}

/** What the needs-scan found in the note (drives which lazy loads happen). */
export interface RendererNeeds {
  readonly math: boolean;
  readonly code: boolean;
  readonly html: boolean;
  readonly emoji: boolean;
  readonly mermaid: boolean;
}

/**
 * True when the environment can actually lay out SVG (a real WebView).
 * jsdom/node lack `SVGGraphicsElement.prototype.getBBox`, which mermaid's
 * renderer requires — so this is the env guard that routes tests (and any
 * headless consumer) to the code-card fallback.
 */
export function realSvgLayoutAvailable(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return false;
  }
  const svgGraphics = (
    globalThis as { SVGGraphicsElement?: { prototype?: object } }
  ).SVGGraphicsElement;
  if (svgGraphics?.prototype === undefined) return false;
  return (
    typeof (svgGraphics.prototype as { getBBox?: unknown }).getBBox ===
    "function"
  );
}

async function loadCodeHighlighter(): Promise<CodeHighlighter> {
  const [{ highlightCode, classHighlighter }, { resolveCodeLanguage }] =
    await Promise.all([
      import("@lezer/highlight"),
      import("../../editor/code-languages"),
    ]);
  return (code, info) => {
    const lang = resolveCodeLanguage(info);
    if (!lang?.support) return null;
    const tree = lang.support.language.parser.parse(code);
    let html = "";
    highlightCode(
      code,
      tree,
      classHighlighter,
      (text, classes) => {
        html += classes
          ? `<span class="${classes}">${escapeHtml(text)}</span>`
          : escapeHtml(text);
      },
      () => {
        html += "\n";
      },
    );
    return html;
  };
}

/**
 * Resolve the lazy renderers a note actually needs; every miss/load failure
 * resolves to `null` so emission degrades to escaped text, never throws.
 * `attemptMermaid` is decided by the caller (env guard / opts).
 */
export async function loadHeavyRenderers(
  needs: RendererNeeds,
  attemptMermaid: boolean,
): Promise<HeavyRenderers> {
  const nullOnFailure = <T>(p: Promise<T>): Promise<T | null> =>
    p.catch(() => null);
  const [math, highlight, purifier, emojiMod, mermaid] = await Promise.all([
    needs.math ? nullOnFailure(loadMathRenderer()) : null,
    needs.code ? nullOnFailure(loadCodeHighlighter()) : null,
    needs.html ? nullOnFailure(loadPurifier()) : null,
    needs.emoji ? nullOnFailure(import("../emoji-shortcodes")) : null,
    needs.mermaid && attemptMermaid
      ? nullOnFailure(loadMermaidRenderer())
      : null,
  ]);
  return {
    math,
    highlight,
    purifier,
    emoji: emojiMod?.EMOJI ?? null,
    mermaid,
  };
}
