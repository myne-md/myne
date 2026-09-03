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

/** Hook payload subset (DOMPurify's `uponSanitizeAttribute` data arg). */
interface SanitizeAttrData {
  attrName: string;
  attrValue: string;
  keepAttr: boolean;
}

/** Minimal surface this module uses from DOMPurify. Exported so the embedded-HTML
 *  decoration shares one definition rather than re-declaring it. */
export interface Purifier {
  sanitize(dirty: string, cfg?: Record<string, unknown>): string;
  addHook(
    entryPoint: "uponSanitizeAttribute",
    hookFn: (node: Element, data: SanitizeAttrData) => void,
  ): void;
}

// The closed multi-color-highlight class vocabulary (decisions.md 2026-06-15).
// `class` survives the sanitizer ONLY as exactly ONE of these tokens, and ONLY
// on a `<mark>` — enforced by the `uponSanitizeAttribute` hook below. `hl-yellow`
// is the default amber (== `--highlight`); the rest are sibling washes.
//
// MYND-632: grown from five to thirteen. Five was too few to categorise with —
// people ran out and started reusing a colour for two meanings, which is worse
// than having none. It stays a CLOSED allowlist: this is the XSS boundary
// (decisions.md 2026-06-15), and the request for arbitrary hex would have
// breached it, so the answer is more tokens, not a different mechanism. Every
// entry needs a matching `--highlight-*` pair (light + dark) in
// `docs/design/colors_and_type.css` and a toolbar entry, or it renders unstyled.
export const HIGHLIGHT_CLASSES = [
  "hl-yellow",
  "hl-green",
  "hl-blue",
  "hl-pink",
  "hl-purple",
  "hl-orange",
  "hl-red",
  "hl-teal",
  "hl-cyan",
  "hl-lime",
  "hl-brown",
  "hl-grey",
  "hl-indigo",
] as const;

/** The allowlist as a membership set — the single partition line between the
 *  two colored-highlight renderers (MYND-637). An owned `hl-*` is rendered by
 *  `decorations/colored-highlight.ts` (clean `==` reveal); anything else stays on
 *  the `decorations/embedded-html.ts` sanitizer path. */
export const HIGHLIGHT_CLASS_SET: ReadonlySet<string> = new Set(HIGHLIGHT_CLASSES);

/** True when `cls` is an allowlisted colored-highlight class. The canonical
 *  ownership test — shared by the two decorations and the toolbar so they cannot
 *  drift on which spans are "colored highlights". */
export function isOwnedHighlightClass(cls: string): boolean {
  return HIGHLIGHT_CLASS_SET.has(cls.toLowerCase());
}

/** The canonical recognizer for a stored colored highlight
 *  `<mark class="hl-X">inner</mark>` — captures the `hl-*` class (group 1) and the
 *  inner text (group 2). Co-located with the allowlist (this file is the
 *  ownership / XSS boundary) so the storage shape is defined once; a change here
 *  keeps `colored-highlight.ts` and `toolbar/highlight-edit.ts` in lockstep. `/g`,
 *  so every consumer resets `lastIndex` before its `exec` loop. */
export const MARK_HL_RE = /<mark class="(hl-[a-z-]+)">([\s\S]*?)<\/mark>/gi;

// Ultra-tight config (the XSS boundary). Only the elements tests.md uses; only
// `title` (for <abbr>) plus `class` (constrained by the hook below to a single
// `hl-*` token on <mark> — nothing else). Everything off-list → escaped to text
// (KEEP_CONTENT). DOMPurify always strips `on*` handlers and non-allowed
// attributes, so no `src`/`href`/`style`/`id` survives, and `class` survives
// ONLY as one allowlisted highlight token on <mark>; no remote resource loads.
const SANITIZE_CONFIG: Readonly<Record<string, unknown>> = {
  ALLOWED_TAGS: ["p", "kbd", "mark", "sub", "sup", "abbr", "details", "summary"],
  ALLOWED_ATTR: ["title", "class"],
  KEEP_CONTENT: true,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

/** Register the highlight-class constraint hook on a purifier instance, once.
 *  DOMPurify has no native class allowlist, so `class` is widened in
 *  `ALLOWED_ATTR` and then narrowed here: keep it only when the element is a
 *  `<mark>` AND the value is exactly one allowlisted `hl-*` token. Drops
 *  multi-class, unknown tokens, and `class` on any other tag. Idempotent —
 *  registering twice would double-drop, which is harmless, but `loadPurifier`
 *  guards so it runs exactly once. */
export function registerHighlightClassHook(purifier: Purifier): void {
  purifier.addHook("uponSanitizeAttribute", (node, data) => {
    if (data.attrName !== "class") return;
    const ok =
      node.nodeName === "MARK" && HIGHLIGHT_CLASS_SET.has(data.attrValue.trim());
    if (!ok) data.keepAttr = false;
  });
}

type Loader = () => Promise<Purifier>;
let load: Loader = async () => {
  const mod = await import("dompurify");
  // An ISOLATED instance, not the module's shared default one, and this is a
  // correctness fix rather than tidiness (myne-md/myne#629).
  //
  // `addHook` mutates whichever instance it is called on, for the life of the
  // process and for EVERY caller of that instance. The hook below drops `class`
  // from everything that is not `<mark class="hl-*">`, which is right for the
  // embedded-HTML surface it was written for and wrong for anyone else. Mermaid
  // bundles DOMPurify and calls `sanitize` on that same shared default instance
  // (`securityLevel: 'strict'`), and Vite dedupes the two imports to one module,
  // so registering here silently stripped every `class` from every rendered
  // diagram. Mermaid styles its nodes through a `<style>` block keyed on those
  // classes, so each shape fell back to the SVG default `fill`, which is black:
  // measured in the shipped WebView as 0 class attributes in a 10753-character
  // SVG whose stylesheet carried `.node rect{fill:#eef0f4}`, against 61 in a
  // plain browser that had never loaded this module.
  //
  // The factory call is what makes the instance private. Nothing about the
  // embedded-HTML rules changes: the same hook, the same `ALLOWED_TAGS` and
  // `ALLOWED_ATTR`, applied to the same input, on an instance no other consumer
  // can reach.
  const factory = mod.default as unknown as (win: typeof globalThis) => Purifier;
  return factory(globalThis) as Purifier;
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
 *  embedded-HTML decorations and the export emitter (SYNC-5 reuse). The
 *  highlight-class hook is registered on first load, so every consumer of this
 *  instance honours the `<mark class="hl-*">` constraint identically. */
export function loadPurifier(): Promise<Purifier> {
  if (purifierPromise === null) {
    purifierPromise = load().then((purifier) => {
      // Guard: test fakes may omit `addHook`; the real DOMPurify default has it.
      if (typeof purifier.addHook === "function") {
        registerHighlightClassHook(purifier);
      }
      return purifier;
    });
  }
  return purifierPromise;
}

/** Sanitize a raw embedded-HTML span to the ultra-tight allowlist. */
export async function sanitizeEmbeddedHtml(raw: string): Promise<string> {
  const purifier = await loadPurifier();
  return purifier.sanitize(raw, { ...SANITIZE_CONFIG });
}

/** The allowlist config, exported for reuse (mermaid SVG sanitize) + testing. */
export { SANITIZE_CONFIG };
