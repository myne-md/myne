// Print stylesheet for the PDF export capture document (MYND-255 task 3).
//
// Form: a TS module exporting a CSS template literal, NOT a `.css` asset.
// Rationale: the capture template (task 4) composes a standalone HTML string
// for the hidden export window and inlines this into a `<style>` tag in its
// `<head>` — a plain exported string needs no Vite `?inline` asset wiring, is
// identical in dev/build/test, and is trivially assertable from Vitest. The
// composed final stylesheet (this CSS + the locale-resolved `@page size` rule)
// comes from `composePrintStylesheet()` in `./page-geometry.ts`.
//
// The document this styles is STANDALONE (no app stylesheet, no
// `colors_and_type.css` link), so the `:root` block below EMBEDS the needed
// custom-property values, resolved from the LIGHT theme in
// `docs/design/colors_and_type.css` — each line names its source token. The
// PDF always renders the light palette (PRD: "print CSS over the design
// tokens, light palette"); there is deliberately no dark/`prefers-color-scheme`
// arm here.
//
// Visual canon: Penpot page "4 — Desktop UI Kit", "PDF export — page style"
// frame (approved): ~20mm margins, title ~26px semibold fg-1, body 13px/1.6
// fg-2, H2 ~19px, callout = radius-2 (6px) container with soft tint + 3px
// accent left bar + bold small title, code block = recessed card + JetBrains
// Mono 11.5px + syntax accents, muted italic 11.5px "not included" line,
// clean footer-free whitespace. NO branding of any kind (PRD story 5).
//
// What the capture template must ALSO put in the head (not duplicated here):
//   - KaTeX's own CSS (the `.math-inline` / `.math-block` content is KaTeX
//     markup; this file only handles block spacing + the error fallback),
//     loaded from the bundled katex chunk (render-math.ts imports it).
//   - `@font-face` rules serving the bundled Inter Variable + JetBrains Mono
//     woff2 files (`public/fonts/`). This stylesheet references the family
//     NAMES only — both the "… Variable" and the plain names used by
//     `colors_and_type.css`'s own @font-face declarations — with system
//     fallbacks, so it degrades sanely if a face fails to load.
//
// Class vocabulary styled here = the emitter's complete emitted set, pinned in
// `agent-tooling/features/note-export-pdf/progress.md` (task 2 handoff) and
// drift-guarded by `tests/dialect/html/print-stylesheet.test.ts`.

// NOTE: the emitted string carries no product/tracker strings at all — the
// zero-branding criterion applies to the shipped CSS text, not just the PDF.
export const PRINT_CSS = `/* Note print stylesheet. Light palette only. */

:root {
  /* Font stacks — names only; faces served by the capture template. */
  --font-sans: "Inter Variable", "Inter", ui-sans-serif, system-ui,
    -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace,
    "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;

  /* Light token values from docs/design/colors_and_type.css (:root). */
  --paper-2:  #f4f4f2;  /* --paper-2 (recessed surfaces: code cards) */
  --line-1:   #e3e2dd;  /* --line-1 (hairline borders) */
  --line-2:   #c8c7c1;  /* --line-2 (stronger borders, table head rule) */
  --fg-1:     #1a1a17;  /* --fg-1 / --ink-1 (titles, headings, emphasis) */
  --fg-2:     #3a3934;  /* --fg-2 / --ink-2 (body text) */
  --fg-3:     #6b6a64;  /* --fg-3 / --ink-3 (muted: captions, placeholders) */
  --accent:       #2c4a7a;  /* --accent (links, wikilinks, info/accent bar) */
  --accent-soft:  #e8edf5;  /* --accent-soft (info/accent callout tint) */
  --danger:       #8a2a23;  /* --danger (danger callout bar) */
  --danger-soft:  #f5e7e5;  /* --danger-soft (danger callout tint) */
  --warning:      #8a6a1f;  /* --warning (warning callout bar) */
  --warning-soft: #f5efde;  /* --warning-soft (warning callout tint) */
  --success:      #2f6048;  /* --success (success callout bar) */
  --success-soft: #e3eee8;  /* --success-soft (success callout tint) */
  --highlight:    #f3e7c4;  /* --highlight (==highlight== / <mark> / hl-yellow wash) */
  --highlight-green:  #d8e9cf;  /* <mark class="hl-green">  wash (print: light only) */
  --highlight-blue:   #d3e2ee;  /* <mark class="hl-blue">   wash */
  --highlight-pink:   #efd8e2;  /* <mark class="hl-pink">   wash */
  --highlight-purple: #e2d8ee;  /* <mark class="hl-purple"> wash */
  --radius-1: 3px;          /* --radius-1 (inline code chips) */
  --radius-2: 6px;          /* --radius-2 (callouts, code cards, images) */

  /* Code syntax palette — --syntax-* light values (MYND-154, AA-pinned). */
  --syntax-keyword:  #7a3b8c;  /* --syntax-keyword */
  --syntax-string:   #3f6a4a;  /* --syntax-string */
  --syntax-comment:  #706f66;  /* --syntax-comment */
  --syntax-number:   #9a5d2a;  /* --syntax-number */
  --syntax-variable: #1a1a17;  /* --syntax-variable */
  --syntax-property: #2c4a7a;  /* --syntax-property */
  --syntax-function: #1f5c6e;  /* --syntax-function */
  --syntax-type:     #8a5a1f;  /* --syntax-type */
  --syntax-operator: #5c5b54;  /* --syntax-operator */
  --syntax-tag:      #8a2a23;  /* --syntax-tag */
  --syntax-meta:     #5a5478;  /* --syntax-meta */
  --syntax-invalid:  #992018;  /* --syntax-invalid */
}

/* === Page geometry =====================================================
   The page SIZE rule (A4/Letter) is appended by composePrintStylesheet()
   (page-geometry.ts) from the OS locale — it is intentionally absent here. */
@page {
  margin: 20mm;
}

* {
  box-sizing: border-box;
  /* Print engines drop background colors by default; the callout tints,
     code cards and the highlight wash are part of the design. */
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

html,
body {
  margin: 0;
  padding: 0;
}

/* True white page (PDF/print convention) — body text on --fg-2 per the
   Penpot frame; --paper (#fbfbfa) is deliberately NOT painted so the content
   box never reads as a tinted rectangle inside the white page margins. */
body {
  background: #ffffff;
  color: var(--fg-2);
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.6;
  font-weight: 400;
  letter-spacing: 0;
  overflow-wrap: break-word;
}

/* RTL / bidi (#172): give each block its own content-derived base direction
   (the print-export mirror of the editor's per-line dir=auto), so a mixed
   RTL+LTR note exports with each paragraph reading in its own direction. Inline
   code / links are isolated so an intrinsically-LTR run does not reorder an RTL
   paragraph around it. (.note-title is an h1, already covered.) */
h1, h2, h3, h4, h5, h6, p, li, blockquote, dt, dd, td, th {
  unicode-bidi: plaintext;
}
code, a {
  unicode-bidi: isolate;
}

/* === Title + heading scale =============================================
   .note-title is the frontmatter-projected document heading (h1.note-title);
   plain h1–h6 are the note's own headings. */
.note-title {
  font-size: 26px;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.015em;
  color: var(--fg-1);
  margin: 0 0 18px;
}

h1, h2, h3, h4, h5, h6 {
  color: var(--fg-1);
  font-weight: 600;
  line-height: 1.3;
  margin: 1.5em 0 0.5em;
  break-after: avoid;
  break-inside: avoid;
  page-break-after: avoid;  /* legacy alias for older print engines */
  page-break-inside: avoid;
}

h1 { font-size: 22px; letter-spacing: -0.015em; }
h2 { font-size: 19px; letter-spacing: -0.015em; }
h3 { font-size: 16px; }
h4 { font-size: 14px; }
h5 { font-size: 13px; }
h6 {
  font-size: 11.5px;
  letter-spacing: 0.08em;  /* --tracking-caps */
  text-transform: uppercase;
  color: var(--fg-3);
}

/* === Body copy ========================================================== */
p {
  margin: 0 0 0.75em;
  widows: 2;
  orphans: 2;
}

a {
  color: var(--accent);
  text-decoration: none;
}

strong { font-weight: 600; color: var(--fg-1); }
em { font-style: italic; }
del { text-decoration: line-through; color: var(--fg-3); }

/* ==highlight== wash; sanitized embedded <mark> gets the same treatment.
   A bare <mark> and <mark class="hl-yellow"> are the default amber; the four
   sibling colors override only the background (decisions.md 2026-06-15). */
.highlight,
mark {
  background: var(--highlight);
  color: inherit;
  padding: 0 2px;
  border-radius: 2px;
}
mark.hl-green  { background: var(--highlight-green); }
mark.hl-blue   { background: var(--highlight-blue); }
mark.hl-pink   { background: var(--highlight-pink); }
mark.hl-purple { background: var(--highlight-purple); }

hr {
  border: none;
  border-top: 1px solid var(--line-1);
  margin: 24px 0;
}

/* === Lists ============================================================== */
ul, ol {
  margin: 0 0 0.75em;
  padding-left: 1.6em;
}
li { margin: 0 0 0.25em; }
li > ul, li > ol { margin-bottom: 0; margin-top: 0.25em; }

.task-list-item {
  list-style-type: none;
  margin-left: -1.25em;
}
.task-checkbox {
  display: inline-block;
  margin-right: 0.4em;
  color: var(--fg-3);
  font-size: 14px;
  line-height: 1;
}
.task-list-item[data-checked="true"] > .task-checkbox {
  color: var(--accent);
}

dl { margin: 0 0 0.75em; }
dt { font-weight: 600; color: var(--fg-1); }
dd { margin: 0 0 0.5em 1.5em; }

/* === Blockquote + callouts ============================================= */
blockquote {
  margin: 0 0 0.75em;
  padding: 2px 0 2px 14px;
  border-left: 3px solid var(--line-2);
  color: var(--fg-2);
}
blockquote > p:last-child { margin-bottom: 0; }

/* Callout container: radius-2 card, soft tone tint, 3px tone bar.
   Tone classes set the two custom properties; the 22 per-type classes
   (callout-note, callout-tip, …) carry no styling of their own — the tone
   is the visual contract. */
.callout {
  --callout-bar: var(--accent);
  --callout-tint: var(--accent-soft);
  background: var(--callout-tint);
  border-left: 3px solid var(--callout-bar);
  border-radius: var(--radius-2);
  padding: 10px 14px;
  margin: 0 0 0.75em;
  break-inside: avoid;
  page-break-inside: avoid;
}
.callout > p:last-child { margin-bottom: 0; }

.callout-tone-info    { --callout-bar: var(--accent);  --callout-tint: var(--accent-soft); }   /* --info / --info-soft */
.callout-tone-success { --callout-bar: var(--success); --callout-tint: var(--success-soft); }
.callout-tone-warning { --callout-bar: var(--warning); --callout-tint: var(--warning-soft); }
.callout-tone-danger  { --callout-bar: var(--danger);  --callout-tint: var(--danger-soft); }
.callout-tone-accent  { --callout-bar: var(--accent);  --callout-tint: var(--accent-soft); }

.callout-title {
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--callout-bar);
  margin: 0 0 4px;
}

/* === Code =============================================================== */
/* Inline code chip (matches the app's .t-code treatment). */
code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: var(--paper-2);
  border: 1px solid var(--line-1);
  border-radius: var(--radius-1);
  padding: 1px 4px;
  color: var(--fg-1);
}

/* Recessed code card. break-inside: avoid keeps short blocks whole; a block
   taller than one page is broken by the engine anyway (interior breaks for
   long code are intended), with widows/orphans softening the cut where the
   engine supports line-level control. */
.code-card {
  background: var(--paper-2);
  border: 1px solid var(--line-1);
  border-radius: var(--radius-2);
  padding: 12px 14px;
  margin: 0 0 0.75em;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  break-inside: avoid;
  page-break-inside: avoid;
  widows: 3;
  orphans: 3;
}
/* Highlighted cards carry data-lang; mono ligature/zero features per .t-mono. */
.code-card[data-lang] code,
.code-card code {
  font: inherit;
  font-feature-settings: "ss02", "zero", "calt";
  background: none;
  border: none;
  border-radius: 0;
  padding: 0;
  color: var(--fg-1);
}

/* Syntax accents: @lezer/highlight classHighlighter classes → --syntax-*
   light values (grouping mirrors src/editor/code-highlight.ts). */
.tok-keyword                      { color: var(--syntax-keyword); }
.tok-string, .tok-string2,
.tok-literal                      { color: var(--syntax-string); }
.tok-comment                      { color: var(--syntax-comment); }
.tok-number, .tok-bool, .tok-atom { color: var(--syntax-number); }
.tok-variableName,
.tok-variableName2                { color: var(--syntax-variable); }
.tok-propertyName, .tok-labelName { color: var(--syntax-property); }
.tok-macroName                    { color: var(--syntax-function); }
.tok-typeName, .tok-className,
.tok-namespace                    { color: var(--syntax-type); }
.tok-operator, .tok-punctuation   { color: var(--syntax-operator); }
.tok-meta                         { color: var(--syntax-meta); }
.tok-invalid                      { color: var(--syntax-invalid); }
.tok-inserted                     { color: var(--success); }  /* diff + lines */
.tok-deleted                      { color: var(--danger); }   /* diff - lines */
.tok-link, .tok-url               { color: var(--syntax-property); }
.tok-heading, .tok-strong         { font-weight: 600; color: var(--fg-1); }
.tok-emphasis                     { font-style: italic; }

/* === Mermaid ============================================================ */
/* The diagram sits on the SAME fixed-light card the editor uses
   (.cm-mermaid-card, theme.ts) so it reads identically: --fg-1 ink for any
   currentColor-derived glyphs, a #fbfbfa surface the mermaid palette assumes. */
.mermaid-diagram {
  margin: 12px 0;
  text-align: center;
  max-width: 100%;
  color: var(--fg-1);
  break-inside: avoid;
  page-break-inside: avoid;
}
.mermaid-diagram svg {
  max-width: 100%;
  height: auto;
  background: #fbfbfa;
  border: 1px solid var(--line-1);
  border-radius: var(--radius-2);
  padding: 12px;
}
/* Render-failure fallback: the code card again, dashed to read as degraded. */
.mermaid-fallback {
  border-style: dashed;
}

/* === Math ===============================================================
   KaTeX markup inside .math-inline/.math-block is styled by KaTeX's own CSS
   (loaded separately by the capture template — see module header). */
.math {
  color: var(--fg-1);  /* math reads as primary content ink */
}
.math-block {
  margin: 12px 0;
  text-align: center;
  break-inside: avoid;
  page-break-inside: avoid;
}
.math-inline {
  white-space: nowrap;
}
/* Invalid LaTeX → the raw $…$ source (editor parity), shown muted mono. */
.math-error {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--fg-3);
}
div.math-error { margin: 0 0 0.75em; }

/* === Footnotes (end-of-document endnotes) =============================== */
.footnote-ref {
  font-size: 0.7em;
  line-height: 0;  /* keep refs from opening up the line box */
}
.footnote-ref a { color: var(--accent); }

.footnotes {
  margin-top: 28px;
  border-top: 1px solid var(--line-1);
  padding-top: 10px;
  font-size: 11.5px;
  color: var(--fg-3);
}
.footnote-list {
  margin: 0;
  padding-left: 1.4em;
}
.footnote-item { margin: 0 0 0.35em; }
.footnote-item p { margin: 0; }

/* === Wikilinks + embeds + raw HTML ====================================== */
/* Wikilink: a styled span, not a link — no underline, no href affordance. */
.wikilink {
  color: var(--accent);
  font-weight: 500;
  text-decoration: none;
}

/* Non-attachment embeds + never-fetched markdown images: small gray chip
   with a muted caption (Penpot "image placeholder" treatment). */
.embed-placeholder {
  display: inline-block;
  background: var(--paper-2);
  border: 1px solid var(--line-1);
  border-radius: var(--radius-1);
  padding: 1px 8px;
  font-size: 11.5px;
  font-style: italic;
  color: var(--fg-3);
}

/* Sanitized embedded-HTML subset inherits body styling; the block form only
   needs paragraph spacing. Off-allowlist HTML (escaped text) reads muted. */
.embedded-html { color: inherit; }
.embedded-html-block { margin: 0 0 0.75em; }
.raw-html {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--fg-3);
}
kbd {
  font-family: var(--font-mono);
  font-size: 0.85em;
  background: var(--paper-2);
  border: 1px solid var(--line-2);
  border-bottom-width: 2px;
  border-radius: var(--radius-1);
  padding: 0 4px;
  color: var(--fg-1);
}

/* === Attachments ======================================================== */
.att-image {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 12px auto;
  border-radius: var(--radius-2);
  break-inside: avoid;
  page-break-inside: avoid;
}

/* Excluded PDF / non-embeddable attachment: muted italic 11.5px line. */
.att-excluded,
.att-placeholder {
  font-size: 11.5px;
  font-style: italic;
  color: var(--fg-3);
}
p.att-excluded,
p.att-placeholder { margin: 0 0 0.75em; }

/* === Tables ============================================================= */
table {
  border-collapse: collapse;
  width: 100%;
  margin: 0 0 0.75em;
  font-size: 12.5px;
}
thead {
  display: table-header-group;  /* repeat the header row across page breaks */
}
th {
  font-weight: 600;
  color: var(--fg-1);
  border-bottom: 1.5px solid var(--line-2);
}
th, td {
  padding: 5px 10px;
  text-align: left;  /* emitter overrides per-cell via inline text-align */
}
td { border-bottom: 1px solid var(--line-1); }
tr {
  break-inside: avoid;  /* break between rows, never through one */
  page-break-inside: avoid;
}

/* === Misc =============================================================== */
img {
  max-width: 100%;
  height: auto;
}
figure { margin: 12px 0; }
figcaption {
  font-size: 11.5px;
  color: var(--fg-3);
  text-align: center;
  margin-top: 4px;
}
`;
