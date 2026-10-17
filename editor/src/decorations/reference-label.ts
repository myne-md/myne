// CommonMark reference-label normalisation, as a leaf module.
//
// # Why this is its own file
//
// `foldLabel` is a pure string function, but it used to live in
// `link-reference-collector.ts`, whose module scope value-imports
// `@codemirror/language` (`syntaxTree`) and `@codemirror/state` (`StateField`).
// `@codemirror/language` depends on `@codemirror/view`, so importing that module
// AT ALL pulled the whole CodeMirror view stack into whoever touched it — and
// the desktop dialect emission code (`src/dialect/text/emitNoteText.ts`,
// `src/dialect/html/emitNoteHtml.ts`, `src/dialect/clip.ts`) touches it from the
// app's FIRST-LOAD graph. First load was carrying ~74 KiB gzip of CodeMirror
// that no pre-unlock screen can use, which `scripts/check-web-bundle-budget.mjs`
// measures.
//
// Nothing here imports anything, deliberately. That is the property the split
// exists to buy: a label fold cannot drag an editor in behind it. Do not add an
// import to this file; add it to the collector instead.

/**
 * Normalize a reference label per CommonMark "matches" rules: strip the
 * surrounding `[` `]` if present, trim, collapse internal whitespace runs to a
 * single space, and case-fold. `toLowerCase()` is a pragmatic stand-in for full
 * Unicode case folding — adequate for v0.1 ASCII-dominant labels; documented in
 * markdown-dialect.md §3.2.
 */
export function foldLabel(raw: string): string {
  let s = raw;
  if (s.length >= 2 && s.startsWith("[") && s.endsWith("]")) {
    s = s.slice(1, -1);
  }
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}
