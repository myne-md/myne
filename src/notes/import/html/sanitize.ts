// Importer — the import-side HTML sanitizer (importer-breadth epic, MYND-580).
//
// SECURITY-LOAD-BEARING. This is the second untrusted-markup boundary in the
// codebase; the first is the MYND-209 render surface
// (`editor/src/html/sanitize.ts`). Imported bytes are attacker-influenceable
// (`threat-model.md` §6: "the threat is a crafted/imported note attacking the
// user"), so they are sanitized BEFORE the DOM→markdown walker ever reads them.
//
// THE ALLOWLIST IS A DELTA, NOT A FRESH CONFIG. It is built by extending the
// render allowlist rather than hand-copying a new list, so a reviewer audits only
// `IMPORT_DELTA_TAGS` / `IMPORT_DELTA_ATTR` and a future change to the render
// allowlist cannot silently desynchronize this one. (Grill 2026-07-25, R3.)
//
// WHY THE DELTA IS WIDER THAN RENDER, AND WHY THAT IS STILL SOUND.
// The render allowlist is 8 elements with no `href`/`src`, justified by "no remote
// fetch is possible — no src/href survives". This config deliberately permits
// structural elements plus `href`/`src`, because:
//   1. The sanitized document here is NEVER RENDERED and never attached to the live
//      document (see `parse.ts`) — it is walked, converted, and discarded.
//   2. The OUTPUT of that walk is markdown TEXT, not DOM. A remote
//      `![](https://…)` in the output is inert: `findImportedImageRefs` excludes
//      URL-bearing refs so the importer never fetches them, and the dialect does
//      not render a raw-path ref as an `<img>` (`markdown-dialect.md` §7). The
//      no-remote-fetch anti-feature therefore still holds structurally.
//   3. URL schemes are narrowed to http/https/mailto/document-relative twice over:
//      by `ALLOWED_URI_REGEXP` here (defence in depth) and by an explicit check in
//      the walker, which is the layer that can REPORT a drop rather than swallow it.
//
// `<script>`, `<iframe>`, `<object>`, `<embed>`, `<style>`, and every `on*` handler
// are absent from the allowlist and are removed by DOMPurify; `KEEP_CONTENT` keeps
// their text children, matching the render surface's behaviour.

import { SANITIZE_CONFIG, loadPurifier } from "@myne/editor/html/sanitize";

/** The render surface's allowlist, read from its own module so the two cannot drift. */
const RENDER_TAGS = SANITIZE_CONFIG["ALLOWED_TAGS"] as readonly string[];
const RENDER_ATTR = SANITIZE_CONFIG["ALLOWED_ATTR"] as readonly string[];

/**
 * The import-only delta over the render allowlist — every element the
 * DOM→markdown walker knows how to convert. Reviewing this array IS reviewing the
 * widening. Anything not here (and not in the render list) is stripped to its text.
 */
export const IMPORT_DELTA_TAGS = [
  // headings → `#`…`######`
  "h1", "h2", "h3", "h4", "h5", "h6",
  // lists → `-` / `1.` (nesting handled by the walker)
  "ul", "ol", "li",
  // tables → GFM pipe tables (markdown-dialect.md §3.3)
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  // quotes + code
  "blockquote", "pre", "code",
  // inline emphasis
  "strong", "b", "em", "i", "del", "s", "u",
  // breaks
  "br", "hr",
  // links + images — the only two that need a URL attribute
  "a", "img",
  // grouping the walker treats as transparent block containers
  "div", "span", "section", "article", "main", "figure", "figcaption",
] as const;

/**
 * The import-only attribute delta. Exactly the three the walker reads. No `style`,
 * no `id`, no `data-*`, no `aria-*` — a converted note carries none of them.
 */
export const IMPORT_DELTA_ATTR = ["href", "src", "alt"] as const;

/**
 * Permitted URL shapes: `http://`, `https://`, `mailto:`, or a document-relative
 * reference (how Notion emits internal links). Everything else — `javascript:`,
 * `data:`, `file:`, `vbscript:` — fails to match, and DOMPurify drops the attribute.
 *
 * FAILS CLOSED, deliberately. An earlier version keyed the relative case on a
 * negative lookahead for "looks like a scheme" (`(?![a-zA-Z][\w+.-]*:)`), which
 * meant anything that *defeated* scheme detection was treated as relative and
 * allowed — `jav\u{FFFD}ascript:alert(1)` (a NUL that HTML parsing turns into
 * U+FFFD) passed straight through into note text. The relative arm now requires
 * that the part before the first `/`, `?`, or `#` contain **no colon at all**, so
 * an unrecognized scheme is rejected rather than mistaken for a path. Found by the
 * adversarial payload battery during the MYND-580 allowlist review (grill R3).
 *
 * Protocol-relative (`//host/x`) still passes: it carries no scheme, and the
 * importer's output is markdown text that is never fetched.
 *
 * CASE-INSENSITIVE, and only the recognizing arm gains by it. URL schemes are
 * case-insensitive per RFC 3986 §3.1 and real exports do emit `HTTPS://`, but
 * DOMPurify tests this pattern against the raw attribute value without folding
 * case — so without `i` an uppercase-scheme link silently lost its `href`. The
 * flag cannot widen the reject set: the relative arm is `[^:]*`, which has no
 * case-bearing literal, and a hostile scheme is rejected by the *absence* of a
 * colon-free prefix, not by letter case (`JavaScript:` fails exactly as
 * `javascript:` does — pinned in `tests/notes/import/import-sanitize.test.ts`).
 */
export const SAFE_URI_REGEXP = /^(?:https?:\/\/|mailto:)|^[^:]*(?:[/?#]|$)/i;

/** The composed import config. Built from the render config + the two deltas. */
export const IMPORT_SANITIZE_CONFIG: Readonly<Record<string, unknown>> = {
  ALLOWED_TAGS: [...RENDER_TAGS, ...IMPORT_DELTA_TAGS],
  ALLOWED_ATTR: [...RENDER_ATTR, ...IMPORT_DELTA_ATTR],
  ALLOWED_URI_REGEXP: SAFE_URI_REGEXP,
  KEEP_CONTENT: true,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  // Return a DOM fragment, not a string — the walker consumes nodes, so
  // serializing back to a string only to re-parse it would be a wasted second
  // parse of attacker-influenced bytes.
  RETURN_DOM_FRAGMENT: true,
};

/**
 * Sanitize untrusted imported markup to the import allowlist, returning a detached
 * `DocumentFragment`. Reuses the shared lazy-loaded DOMPurify instance (no second
 * copy of the dependency, no eager cost for users who never import).
 *
 * The returned fragment is detached and MUST stay that way — see `parse.ts`.
 */
export async function sanitizeImportedHtml(raw: string): Promise<DocumentFragment> {
  const purifier = await loadPurifier();
  return purifier.sanitize(
    raw,
    IMPORT_SANITIZE_CONFIG,
  ) as unknown as DocumentFragment;
}
