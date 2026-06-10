// Embedded-HTML sanitizer (MYND-209, embedded-html-rendering; the SYNC-5
// trusted-input boundary).
//
// Note content reaches the DOM ONLY via this helper: DOMPurify-sanitized output
// under an ULTRA-TIGHT allowlist. This is the actual XSS boundary — `decisions.md`
// 2026-06-08 reverses the prior "no sanitizer / forbid-raw-HTML" posture; §8 of
// markdown-dialect.md is amended accordingly.
//
// DOMPurify is LAZY-LOADED via dynamic `import()` (code-split out of the cold
// editor bundle, SYNC-4) — a note with no embedded HTML pays zero bytes.

/** Minimal surface this module uses from DOMPurify. Exported so the embedded-HTML
 *  decoration shares one definition rather than re-declaring it. */
export interface Purifier {
  sanitize(dirty: string, cfg?: Record<string, unknown>): string;
}

// Ultra-tight config (the XSS boundary). Only the elements tests.md uses; only
// `title` (for <abbr>). Everything off-list → escaped to text (KEEP_CONTENT).
// DOMPurify always strips `on*` handlers and non-allowed attributes, so no
// `src`/`href`/`style`/`class`/`id` survives, and no remote resource can load.
const SANITIZE_CONFIG: Readonly<Record<string, unknown>> = {
  ALLOWED_TAGS: ["p", "kbd", "mark", "sub", "sup", "abbr", "details", "summary"],
  ALLOWED_ATTR: ["title"],
  KEEP_CONTENT: true,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

type Loader = () => Promise<Purifier>;
let load: Loader = async () => {
  const mod = await import("dompurify");
  return mod.default as unknown as Purifier;
};
let purifierPromise: Promise<Purifier> | null = null;

/** Override the DOMPurify loader (tests only); returns a restore fn. */
export function setSanitizerLoader(loader: Loader): () => void {
  const prev = load;
  load = loader;
  purifierPromise = null;
  return () => {
    load = prev;
    purifierPromise = null;
  };
}

/** Lazy-load DOMPurify once (cached promise) — shared by the inline + block
 *  embedded-HTML decorations and the mermaid SVG sanitizer (SYNC-5 reuse). */
export function loadPurifier(): Promise<Purifier> {
  if (purifierPromise === null) purifierPromise = load();
  return purifierPromise;
}

/** Sanitize a raw embedded-HTML span to the ultra-tight allowlist. */
export async function sanitizeEmbeddedHtml(raw: string): Promise<string> {
  const purifier = await loadPurifier();
  return purifier.sanitize(raw, { ...SANITIZE_CONFIG });
}

/** The allowlist config, exported for reuse (mermaid SVG sanitize) + testing. */
export { SANITIZE_CONFIG };
