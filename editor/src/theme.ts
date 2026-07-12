// Myne editor theme — maps all CodeMirror 6 CSS classes used by decorations
// + floating surfaces to design tokens via `var(--*)` CSS variable
// references.
//
// PRD `editor-mvp-baseline` stories 47-49, 67. No hardcoded color values;
// OS `prefers-color-scheme` switching happens at the CSS variable layer
// (`docs/design/colors_and_type.css`) — the editor extension inherits
// automatically. No JS-side light/dark mode tracking.

import { EditorView } from "@codemirror/view";
import { tagChipCmTheme } from "@myne/editor/host/notes/tagPillToken";

export const myneTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--fg-1)",
    // Editor-typography presets (set live as CSS custom properties on the
    // editor's content wrapper in PaneView from `usePrefs`). The fallbacks are
    // the canonical defaults, so an editor mounted outside that wrapper (or a
    // pre-feature vault) renders exactly as before. Heading sizes below are
    // `em`-relative, so they scale with `--editor-text-size`.
    fontFamily: "var(--editor-font-family, var(--font-mono))",
    fontSize: "var(--editor-text-size, 14px)",
    lineHeight: "var(--editor-line-spacing, 1.7)",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "inherit",
  },
  ".cm-content": {
    caretColor: "var(--accent, #2c4a7a)",
    // Fill the scroller so the empty area below the text is part of the editable
    // surface — clicking there reaches the editor (and lands the caret on the
    // last line, MYND-162 feedback) instead of being dead space.
    minHeight: "100%",
  },
  "&.cm-focused": {
    outline: "none",
  },
  // focus-mode (MYND-348): highlightActiveLine() is mounted only to supply the
  // `.cm-activeLine` class for focus-mode line-dimming (tokens.css). Neutralize
  // its default background so it is invisible in normal mode.
  ".cm-activeLine": {
    background: "transparent",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--accent, #2c4a7a)",
  },
  // Text selection (double-click word, drag, Cmd/Ctrl+A). A neutral `--paper-3`
  // fill is invisible in dark mode, so tint with the accent (flips per theme, so
  // the wash stays visible in both light and dark). BOTH focus states are styled:
  // CodeMirror's built-in UNFOCUSED selection is a light wash that washes out
  // dark-mode text the moment focus leaves the editor (e.g. the floating
  // selection toolbar opens) — restyle it too, dim but still contrast-safe, so a
  // selection stays readable regardless of focus. The focused wash is fuller,
  // keeping a subtle "focus is here" cue.
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent, #2c4a7a) 18%, transparent)",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent, #2c4a7a) 28%, transparent)",
  },

  // Headings — apply via `Decoration.line` from heading.ts.
  ".cm-h1": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "2em",
    fontWeight: "700",
    lineHeight: "1.25",
    letterSpacing: "-0.015em",
    // No margin/padding on .cm-line — CM6's vertical cursor movement
    // relies on `coordsAtPos`/`posAtCoords` round-tripping cleanly. Block
    // spacing on the line wrapper breaks the math; use line-height for
    // breathing room instead.
  },
  ".cm-h2": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "1.571em",
    fontWeight: "700",
    lineHeight: "1.3",
  },
  ".cm-h3": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "1.286em",
    fontWeight: "600",
    lineHeight: "1.35",
  },
  ".cm-h4": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "1.143em",
    fontWeight: "600",
    lineHeight: "1.4",
  },
  ".cm-h5": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "1em",
    fontWeight: "600",
    lineHeight: "1.4",
  },
  ".cm-h6": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "0.929em",
    fontWeight: "600",
    lineHeight: "1.4",
    color: "var(--fg-2)",
  },

  // Inline marks — text style classes from emphasis.ts / link.ts / inline-code.ts.
  ".cm-bold": { fontWeight: "700" },
  ".cm-italic": { fontStyle: "italic" },
  ".cm-strike": { textDecoration: "line-through" },
  ".cm-link": { textDecoration: "underline", color: "var(--accent, #2c4a7a)" },
  // Clickable autolinks / bare URLs (MYND-150 + MYND-151) carry `data-cm-url`;
  // give them a pointer cursor so the open-on-click affordance reads. Regular
  // `[text](url)` links don't carry the attribute (click reveals source).
  ".cm-link[data-cm-url]": { cursor: "pointer" },
  ".cm-inline-code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.95em",
    backgroundColor: "var(--paper-2, #f3f1eb)",
    padding: "1px 4px",
    borderRadius: "var(--radius-1, 3px)",
  },

  // Plain list rendering — list.ts (MYND-208). Off-cursor, the raw `-`/`1.`
  // marker becomes a muted glyph/number; the line gets a hanging indent so
  // wrapped lines align under the body, not the marker. Markers recede in
  // `--fg-3` (Penpot "list rendering" frame); body stays `--fg-1`.
  // CSS-drawn bullet (the widget carries no glyph): a filled disc top-level, a
  // hollow ring when nested — both the same size + baseline, unlike the `•`/`◦`
  // glyphs which rendered as a tiny high dot vs a big ring. The 1ch slot +
  // `text-align: center` seats the dot; `margin-right` is the gap to the body.
  // inline-flex at the line's height + center → the dot sits at the vertical
  // middle of the line (where the text sits), deterministically — not at the
  // baseline like an empty inline-block would.
  ".cm-list-bullet": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1ch",
    height: "1.7em",
    marginRight: "0.4ch",
    verticalAlign: "top",
  },
  ".cm-list-bullet::before": {
    content: '""',
    flex: "none",
    width: "0.34em",
    height: "0.34em",
    borderRadius: "50%",
    backgroundColor: "var(--fg-3, #6b6a64)",
  },
  ".cm-list-bullet-ring::before": {
    backgroundColor: "transparent",
    border: "1.5px solid var(--fg-3, #6b6a64)",
    boxSizing: "border-box",
  },
  ".cm-list-number": {
    color: "var(--fg-3, #6b6a64)",
  },
  // Hanging indent. The `+ 6px` keeps the MARKER aligned with the body text
  // column (CM's default `.cm-line` left padding is 6px) instead of hanging it at
  // the line's hard left edge — at x≈0 the top-level •/* /+ markers fell 6px into
  // the gutter and read as "no marker at all". Wrapped lines still hang to 1.5em.
  ".cm-list-item-line": {
    textIndent: "-1.5em",
    paddingLeft: "calc(1.5em + 6px)",
  },

  // Inline typography — highlight / sub / sup from inline-typography.ts
  // (MYND-156). `.cm-highlight` is the SYNC-6 shared class reused by
  // embedded-html-rendering's `<mark>`. Sub/sup reuse the footnote-marker
  // metrics (0.75em + line-height 0 so line spacing isn't disturbed). Penpot
  // "inline typography" frame; `--highlight` is a muted warm-amber wash.
  ".cm-highlight": {
    backgroundColor: "var(--highlight, #f3e7c4)",
    borderRadius: "var(--radius-1, 3px)",
    padding: "1px 3px",
    color: "var(--fg-1)",
  },
  ".cm-sub": {
    fontSize: "0.75em",
    lineHeight: "0",
    verticalAlign: "sub",
  },
  ".cm-sup": {
    fontSize: "0.75em",
    lineHeight: "0",
    verticalAlign: "super",
  },

  // Embedded HTML (MYND-209) — the sanitized element keeps its real tag; style
  // <mark>/<kbd> to match the dialect. <sub>/<sup>/<abbr> use native rendering.
  // DISCRIMINATOR (soft-tint option): render the output, marked ONLY by a faint
  // background wash — no border, no label, no underline. The wash is a low-%
  // accent mix over paper, so it reads as a set-apart "embed region", stays
  // distinct from the warm hover/selection greys, and flips with the theme. If a
  // WebView lacks `color-mix` the property is simply dropped (renders seamless).
  ".cm-embedded-html": {
    backgroundColor: "color-mix(in srgb, var(--accent, #2c4a7a) 10%, var(--paper, #fbfbfa))",
    borderRadius: "var(--radius-1, 3px)",
    padding: "0 3px",
  },
  ".cm-embedded-html mark": {
    backgroundColor: "var(--highlight, #f3e7c4)",
    borderRadius: "var(--radius-1, 3px)",
    padding: "1px 3px",
    color: "var(--fg-1)",
  },
  // Multi-color highlight (decisions.md 2026-06-15): `<mark class="hl-…">`
  // overrides ONLY the wash; radius/padding/ink inherit the base rule above.
  // Class set is closed at the sanitizer (HIGHLIGHT_CLASSES); `hl-yellow` is the
  // default amber alias. An unknown/stripped class falls back to the base mark.
  ".cm-embedded-html mark.hl-yellow": {
    backgroundColor: "var(--highlight, #f3e7c4)",
  },
  ".cm-embedded-html mark.hl-green": {
    backgroundColor: "var(--highlight-green, #d8e9cf)",
  },
  ".cm-embedded-html mark.hl-blue": {
    backgroundColor: "var(--highlight-blue, #d3e2ee)",
  },
  ".cm-embedded-html mark.hl-pink": {
    backgroundColor: "var(--highlight-pink, #efd8e2)",
  },
  ".cm-embedded-html mark.hl-purple": {
    backgroundColor: "var(--highlight-purple, #e2d8ee)",
  },
  ".cm-embedded-html kbd": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.85em",
    backgroundColor: "var(--paper-2, #f3f1eb)",
    border: "1px solid var(--line-1, #e3e2dd)",
    borderRadius: "var(--radius-1, 3px)",
    padding: "1px 4px",
  },
  // Block embed — same soft tint, as a tinted panel. `padding` not `margin`
  // (measured-height fix, see math block); no border, no label.
  ".cm-embedded-html-block": {
    display: "block",
    padding: "10px 14px",
    backgroundColor: "color-mix(in srgb, var(--accent, #2c4a7a) 10%, var(--paper, #fbfbfa))",
    borderRadius: "var(--radius-2, 6px)",
  },
  ".cm-embedded-html-block summary": {
    cursor: "pointer",
    fontWeight: "600",
  },

  // Math (MYND-48) — KaTeX output. Block math centers as a card-like row;
  // invalid LaTeX shows source with a quiet dotted underline + hover message.
  // Vertical breathing room is `padding`, NOT `margin`: a block-widget's outer
  // margin is OUTSIDE the box CM6 measures, so it isn't counted in the height
  // map — clicks below accumulate a "lands one line lower" drift. Padding lives
  // inside the measured box, so the height map stays correct. (Same fix applied
  // to every block widget below: mermaid, table, embedded-HTML, footnotes.)
  ".cm-math-block": {
    display: "block",
    textAlign: "center",
    padding: "8px 0",
    overflowX: "auto",
    cursor: "pointer",
  },
  ".cm-math-error": {
    textDecoration: "underline dotted var(--fg-3, #6b6a64)",
    textDecorationSkipInk: "none",
    cursor: "pointer",
  },
  ".cm-math-inline": { cursor: "pointer" },

  // Spell-check squiggle (MYND-264, SYNC-9) — a wavy red underline driven by
  // the `--danger` design token (no hex), tracking the glyphs via
  // text-decoration-skip-ink. Decoration-only overlay; never mutates the buffer.
  ".cm-spell-error": {
    textDecoration: "underline wavy var(--danger, #8a2a23)",
    textDecorationSkipInk: "none",
  },

  // Mermaid diagrams (MYND-49) — rendered SVG sits on its OWN fixed-light card so
  // it reads in BOTH editor themes (Mermaid's palette assumes a light surface; on
  // the dark editor its edge labels were unreadable). The outer `.cm-mermaid` is a
  // transparent, measured spacer (padding, not margin — see note above); the inner
  // `.cm-mermaid-card` carries the light surface.
  ".cm-mermaid": {
    display: "block",
    textAlign: "center",
    padding: "8px 0",
  },
  ".cm-mermaid-card": {
    display: "inline-block",
    maxWidth: "100%",
    overflowX: "auto",
    backgroundColor: "#fbfbfa",
    border: "1px solid #e3e2dd",
    borderRadius: "var(--radius-2, 6px)",
    padding: "16px",
    color: "#1a1a17",
  },
  ".cm-mermaid-fallback .cm-mermaid-card": {
    display: "block",
  },
  ".cm-mermaid-fallback pre": {
    margin: "0",
    textAlign: "left",
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    color: "#1a1a17",
    overflowX: "auto",
  },

  // Line-number gutter (editor-line-numbers / MYND-314) — opt-in, off by default.
  // Prose-first: the gutter blends into the editor surface (no chrome block) and
  // the numbers recede — faint, mono, slightly smaller — so they never compete
  // with the prose.
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--fg-3, #6b6a64)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    // Vertically center the number on the line's text row so it aligns with the
    // prose AND the fold chevron (which already centers). CM's default top-aligns
    // the number, which floats it above the text on tall heading lines — the
    // misalignment in the gutter (MYND-299 QA). Right-aligned toward the content.
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    color: "var(--fg-3, #6b6a64)",
    opacity: "0.5",
    fontFamily: "var(--font-mono)",
    fontSize: "0.8em",
    padding: "0 12px 0 8px",
    minWidth: "1.6em",
  },

  // Fold gutter (heading-list-folding / MYND-300) — HOVER-REVEAL, Obsidian-style
  // minimal chrome on a prose-first editor. The gutter slot stays narrow + quiet;
  // the fold arrow appears only when the editor is hovered (the "can fold" ⌄),
  // EXCEPT a line that is currently folded keeps its › visible so the user can
  // always find + click to unfold. Tokens only (no hex).
  ".cm-foldGutter .cm-gutterElement": {
    padding: "0 2px",
    minWidth: "1.1em",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  ".cm-fold-marker": {
    color: "var(--fg-3, #6b6a64)",
    cursor: "pointer",
    fontSize: "0.9em",
    lineHeight: "1",
    userSelect: "none",
    transition:
      "opacity var(--duration-fast, 120ms) var(--ease-standard, ease), color var(--duration-fast, 120ms) var(--ease-standard, ease)",
  },
  // "Can fold" arrow: invisible until the editor is hovered (hover-reveal).
  '.cm-fold-marker[data-fold-open="true"]': {
    opacity: "0",
  },
  '&:hover .cm-fold-marker[data-fold-open="true"]': {
    opacity: "0.7",
  },
  // A FOLDED line's arrow stays visible (and reads as accent) so it can't be
  // lost — folding is reversible only if the affordance is findable.
  '.cm-fold-marker[data-fold-open="false"]': {
    opacity: "1",
    color: "var(--accent, #2c4a7a)",
  },
  ".cm-fold-marker:hover": {
    color: "var(--accent, #2c4a7a)",
  },

  // Inline collapsed-section placeholder (the `⋯` shown where folded text was).
  // A quiet pill on the recessed surface; clickable to unfold.
  ".cm-foldPlaceholder": {
    display: "inline-block",
    margin: "0 2px",
    padding: "0 6px",
    backgroundColor: "var(--paper-2, #f3f1eb)",
    border: "1px solid var(--line-1, #e3e2dd)",
    borderRadius: "var(--radius-1, 3px)",
    color: "var(--fg-3, #6b6a64)",
    fontFamily: "var(--font-sans)",
    fontSize: "0.85em",
    lineHeight: "1.2",
    cursor: "pointer",
    verticalAlign: "baseline",
  },
  ".cm-foldPlaceholder:hover": {
    backgroundColor: "var(--paper-3, #ece9e2)",
    color: "var(--fg-1)",
    borderColor: "var(--line-2, #c8c7c1)",
  },

  // Dialect comment `%%…%%` (editor-comments / MYND-315) — shown DIMMED in the
  // editor (always visible as a de-emphasized comment, never fully hidden: a
  // comment you cannot see is invisible-and-confusing UX). It is stripped from
  // rendered output + lossy exports by the dialect strip, NOT by this decoration.
  ".cm-comment": {
    color: "var(--fg-3, #6b6a64)",
    opacity: "0.6",
    fontStyle: "italic",
  },

  // Callouts (MYND-47) — a colored tint on each callout line (composes with
  // blockquote's left bars) + an icon+title header. Colors reuse the semantic
  // soft/solid tokens; `-bg-` tints the line, `-fg-` colors the title+icon.
  ".cm-callout-bg-info": { backgroundColor: "var(--info-soft, #e8edf5)" },
  ".cm-callout-bg-success": { backgroundColor: "var(--success-soft, #e3eee8)" },
  ".cm-callout-bg-warning": { backgroundColor: "var(--warning-soft, #f5efde)" },
  ".cm-callout-bg-danger": { backgroundColor: "var(--danger-soft, #f5e7e5)" },
  ".cm-callout-bg-accent": { backgroundColor: "var(--accent-soft, #e8edf5)" },
  ".cm-callout-title": {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    fontWeight: "700",
  },
  ".cm-callout-fg-info": { color: "var(--info, #2c4a7a)" },
  ".cm-callout-fg-success": { color: "var(--success, #2f6048)" },
  ".cm-callout-fg-warning": { color: "var(--warning, #8a6a1f)" },
  ".cm-callout-fg-danger": { color: "var(--danger, #8a2a23)" },
  ".cm-callout-fg-accent": { color: "var(--accent, #2c4a7a)" },

  // Block decorations — line classes from blockquote.ts / frontmatter.ts.
  // Left bar(s) + indent are painted per-line by blockquote.ts as a
  // `--line-2` gradient background (one bar per nesting level, Penpot spec),
  // so the static border/padding live there, not here. This rule carries only
  // the shared body treatment.
  ".cm-blockquote": {
    color: "var(--fg-2)",
    fontStyle: "italic",
  },
  // Definition lists — line classes from definition-list.ts (MYND-152). Term
  // reads as a label; definition rows indent under it with the `:` hidden.
  ".cm-def-term": {
    fontWeight: "700",
    color: "var(--fg-1)",
  },
  ".cm-def-desc": {
    paddingLeft: "20px",
    color: "var(--fg-2)",
  },
  ".cm-frontmatter": {
    backgroundColor: "var(--paper-2, #f3f1eb)",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    color: "var(--fg-2)",
    paddingLeft: "12px",
  },

  // GFM table block widget from decorations/table.ts. Read-only grid; the
  // raw pipe source is reached via cursor-aware whole-table reveal (Task 2).
  // `.cm-table-scroll` contains horizontal overflow so wide tables scroll in
  // their own box without breaking the editor's vertical layout.
  // `padding` (not `margin`) for the same height-map reason as the math/mermaid
  // block widgets above — an outer margin here drifts every click below the table.
  // inline-block + max-width:100% + overflow-x:auto is the proven "scroll inside
  // the widget, never the editor" pattern (mirrors `.cm-mermaid-card`). A `block`
  // here fills the editor width and lets a wide table overflow into the editor's
  // own horizontal scroller (MYND-162 feedback: "only the table should scroll").
  ".cm-table-scroll": {
    display: "inline-block",
    overflowX: "auto",
    maxWidth: "100%",
    verticalAlign: "top",
    padding: "10px 0",
  },
  ".cm-table": {
    borderCollapse: "collapse",
    width: "auto",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    lineHeight: "1.5",
    color: "var(--fg-1)",
  },
  ".cm-table th, .cm-table td": {
    border: "1px solid var(--line-1, #d8d5cc)",
    padding: "6px 12px",
    textAlign: "left",
    verticalAlign: "top",
    position: "relative", // anchors the per-cell affordances
    // Default (empty 2×2) columns are evenly sized at this width; long content
    // does NOT wrap — the cell widens and the whole table scrolls horizontally
    // (`.cm-table-scroll`), Obsidian-style, instead of growing a tall wall.
    minWidth: "6em",
    whiteSpace: "nowrap",
  },
  // Borders-only table (MYND-162 feedback): no header fill, no zebra striping —
  // cells share the editor background; the header reads as distinct by its bold
  // weight alone. A single surface colour + the cell borders, Obsidian-style.
  ".cm-table th": {
    fontWeight: "700",
  },
  // Rendered cell content lives in its own block span so a cell keeps the exact
  // same box whether it shows rendered marks or the edit input (no resize on
  // focus, MYND-162 feedback). `display: block` so the input's `width: 100%`
  // fills the cell without the input's intrinsic size widening it.
  ".cm-table-cell-text": {
    display: "block",
    minWidth: "0",
  },
  // An empty cell reserves a full line so it matches the height of filled cells
  // (otherwise an empty row collapses thinner — MYND-162 feedback).
  ".cm-table-cell-text:empty::before": {
    content: '"\\00a0"', // non-breaking space
  },
  // In-place cell editor (decorations/table.ts, MYND-162). A bare field that
  // fills its cell and inherits the cell's font / colour / left alignment, so the
  // active cell reads as the same grid — no border or focus ring, just a caret.
  ".cm-table-cell-input": {
    width: "100%",
    minWidth: "0", // never widen the cell from the input's intrinsic size
    boxSizing: "border-box",
    border: "none",
    outline: "none",
    boxShadow: "none",
    appearance: "none",
    WebkitAppearance: "none",
    padding: "0",
    margin: "0",
    background: "transparent",
    font: "inherit",
    lineHeight: "inherit",
    color: "inherit",
    textAlign: "inherit", // matches the rendered cell (left by default)
    caretColor: "var(--accent, #2c4a7a)",
  },
  // Visible text selection inside a cell editor — the editor's default
  // `::selection` is `--paper-3`, identical to a header cell's fill, so a
  // selection there is invisible. Use a tinted accent instead.
  ".cm-table-cell-input::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent, #2c4a7a) 28%, transparent)",
  },
  // While editing, the rendered text is replaced by the input and the host's
  // min-width is pinned (in JS) to the frozen rendered width so the cell can't
  // collapse. `min-height` keeps an EMPTY cell one line tall so the caret shows.
  ".cm-table-cell-text.cm-table-cell-editing": {
    minHeight: "1.5em",
  },

  // Editable-table affordances (decorations/table.ts, MYND-162). The editable
  // table is a CSS GRID so the add-row / add-column controls are grid cells
  // ATTACHED to the table (and scroll WITH it), Obsidian-style — not floaters at
  // the viewport edge. `contain: inline-size` keeps the (possibly very wide) table
  // from growing `.cm-content`, so only this box scrolls, never the editor. The
  // left/top padding forms the reorder gutters. Every affordance reveals only when
  // its OWN edge zone is hovered (not on whole-table hover).
  ".cm-table-block": {
    position: "relative",
    display: "block",
    maxWidth: "100%",
  },
  ".cm-table-editable": {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "auto auto",
    gridTemplateRows: "auto auto",
    gridTemplateAreas: '"tbl addcol" "addrow ."',
    justifyContent: "start",
    gap: "3px",
    width: "100%",
    boxSizing: "border-box",
    contain: "inline-size",
    overflowX: "auto",
    overflowY: "visible",
    padding: "16px 0 0 34px", // top = column-handle gutter, left = row-handle gutter
  },
  ".cm-table-editable > table": { gridArea: "tbl" },
  // Reorder handles — bare six-dot grips in the gutter (no chip), revealed only
  // when their own edge strip is hovered: the strip above a column / left of a row.
  ".cm-table-handle": {
    position: "absolute",
    boxSizing: "border-box",
    background: "transparent",
    color: "var(--fg-3, #888)",
    cursor: "grab",
    opacity: "0",
    transition: "opacity 0.1s ease, color 0.1s ease",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "15px",
    lineHeight: "1",
    userSelect: "none",
  },
  ".cm-table-handle::before": { content: '"\\283f"' }, // ⠿ six-dot grip
  ".cm-table-handle-col": { top: "-16px", left: "0", right: "0", height: "16px", justifyContent: "flex-start", paddingLeft: "2px" },
  ".cm-table-handle-row": { left: "-16px", top: "0", bottom: "0", width: "16px" },
  ".cm-table-handle-col:hover, .cm-table-handle-row:hover": { opacity: "1" },
  ".cm-table-handle:hover": { color: "var(--accent, #2c4a7a)" },
  ".cm-table-handle:active": {
    cursor: "grabbing",
    color: "var(--accent, #2c4a7a)",
    opacity: "1",
  },
  // Delete controls — a small × in the gutter beside each reorder handle, revealed
  // together with it (delete-column above the column, delete-row left of the row).
  ".cm-table-del": {
    position: "absolute",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "15px",
    height: "15px",
    border: "none",
    borderRadius: "3px",
    background: "transparent",
    color: "var(--fg-3, #888)",
    cursor: "pointer",
    fontSize: "13px",
    lineHeight: "1",
    padding: "0",
    opacity: "0",
    transition: "opacity 0.1s ease, color 0.1s ease",
  },
  ".cm-table-del::before": { content: '"\\00d7"' }, // ×
  ".cm-table-del:hover": { color: "var(--extended-color-red-600, #c0392b)" },
  ".cm-table-del-col": { top: "-16px", right: "0" },
  ".cm-table-del-row": { left: "-31px", top: "50%", transform: "translateY(-50%)" },
  ".cm-table-handle-col:hover ~ .cm-table-del-col, .cm-table-del-col:hover": {
    opacity: "1",
  },
  ".cm-table-handle-row:hover ~ .cm-table-del-row, .cm-table-del-row:hover": {
    opacity: "1",
  },
  // Add controls — grid cells attached to the table's right (full height) / bottom
  // (full width); each reveals only when its own edge zone is hovered.
  ".cm-table-add-col, .cm-table-add-row": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    border: "1px solid var(--line-1, #d8d5cc)",
    background: "transparent",
    color: "var(--fg-3, #888)",
    cursor: "pointer",
    padding: "0",
    fontSize: "15px",
    lineHeight: "1",
    opacity: "0",
    transition: "opacity 0.1s ease, background 0.1s ease, color 0.1s ease",
  },
  ".cm-table-add-col::before, .cm-table-add-row::before": { content: '"+"' },
  ".cm-table-add-col": { gridArea: "addcol", width: "18px", borderRadius: "0 4px 4px 0" },
  ".cm-table-add-row": { gridArea: "addrow", height: "18px", borderRadius: "0 0 4px 4px" },
  // Revealed via JS (`.cm-revealed`, see revealOnHover) so it never sticks open
  // after a widget rebuild; the accent highlight is on real `:hover`.
  ".cm-table-add-col.cm-revealed, .cm-table-add-row.cm-revealed": {
    opacity: "1",
  },
  ".cm-table-add-col:hover, .cm-table-add-row:hover": {
    background: "var(--accent-soft, #e8edf5)",
    color: "var(--accent, #2c4a7a)",
  },
  // Drag-reorder feedback (#13): the row/column being dragged is tinted so you
  // see what you're moving; the drop target shows an insertion-edge LINE (left
  // edge for a column, top edge for a row) marking where it will land — not a box.
  ".cm-table-dragging": {
    backgroundColor: "color-mix(in srgb, var(--accent, #2c4a7a) 14%, transparent)",
  },
  ".cm-table-drop-col": {
    boxShadow: "inset 2px 0 0 0 var(--accent, #2c4a7a)",
  },
  ".cm-table-drop-row": {
    boxShadow: "inset 0 2px 0 0 var(--accent, #2c4a7a)",
  },

  // Fenced code-block card from decorations/fenced-code.ts (MYND-154). Built
  // from per-line decorations so the body stays live document text and the
  // task-3 nested parser colors it. Side borders run on every body line; the
  // top/bottom lines round the card. Mono font; tokens colored via --syntax-*.
  ".cm-code-card-body": {
    backgroundColor: "var(--paper-2)",
    borderLeft: "1px solid var(--line-1)",
    borderRight: "1px solid var(--line-1)",
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
    lineHeight: "1.5",
    padding: "0 16px",
  },
  // Vertical padding matches the 16px sides so all four inner edges read equal
  // (the top/bottom gap used to be 8px — half the sides). In the away state the
  // top gap comes from the bar's bottom padding (above); in the editing state the
  // first/last body lines (which show the raw fences) carry it via the rules below.
  // Editing-state line rounding (raw fence shown): top/bottom body lines round.
  ".cm-code-card-top": {
    borderTop: "1px solid var(--line-1)",
    borderTopLeftRadius: "var(--radius-2, 6px)",
    borderTopRightRadius: "var(--radius-2, 6px)",
    paddingTop: "16px",
  },
  ".cm-code-card-bottom": {
    borderBottom: "1px solid var(--line-1)",
    borderBottomLeftRadius: "var(--radius-2, 6px)",
    borderBottomRightRadius: "var(--radius-2, 6px)",
    paddingBottom: "16px",
  },
  // Away-state card-top bar widget (replaces the opening fence line); carries
  // the language badge top-right. Side + top borders + top radius continue the
  // card around the body lines below.
  // Away-state bar: a 0-height OVERLAY anchored on the (collapsed) opening-fence
  // line. It contributes no vertical row, so the first code line — which is now
  // the card's visual top (`cm-code-card-top`, 16px top padding) — keeps the same
  // inset as the other three edges. The badge + copy float in the top-right corner
  // via `.cm-code-bar-cluster`.
  ".cm-code-card-bar": {
    position: "relative",
    height: "0",
    overflow: "visible",
  },
  // Empty block (```lang```): no body to overlay onto, so this variant stays a
  // real, visible rounded bar holding the badge.
  ".cm-code-card-bar-full": {
    height: "auto",
    minHeight: "34px",
    backgroundColor: "var(--paper-2)",
    border: "1px solid var(--line-1)",
    borderRadius: "var(--radius-2, 6px)",
  },
  ".cm-code-bar-cluster": {
    position: "absolute",
    top: "7px",
    right: "12px",
    zIndex: "1",
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    // Paper-2 backing so a long first code line passing under the cluster is
    // cleanly occluded rather than peeking through the label.
    backgroundColor: "var(--paper-2)",
    paddingLeft: "8px",
    borderRadius: "var(--radius-1, 3px)",
  },
  // Language badge inside the bar. Decorative, non-selectable.
  ".cm-code-badge": {
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "var(--fg-3)",
    userSelect: "none",
    pointerEvents: "none",
  },
  // Copy control (MYND-154 task 6) — borderless, icon-only. Hidden until the
  // pointer is anywhere over the block (the `is-hovered` class is toggled on the
  // bar by the hover tracker in fenced-code.ts), then the bare clipboard icon
  // fades in; click swaps to a green check.
  ".cm-code-copy": {
    opacity: "0",
    transition:
      "opacity var(--duration-fast, 120ms) var(--ease-standard, ease), color var(--duration-fast, 120ms) var(--ease-standard, ease)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "18px",
    height: "18px",
    padding: "0",
    color: "var(--fg-3)",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    userSelect: "none",
  },
  ".cm-code-card-bar.is-hovered .cm-code-copy, .cm-code-copy:focus-visible": {
    opacity: "1",
  },
  ".cm-code-copy:hover": {
    color: "var(--fg-1)",
  },
  ".cm-code-copy-done": {
    opacity: "1",
    color: "var(--success, #2f6048)",
  },

  // Code block nested inside a blockquote / list (read-only contained widget
  // from fenced-code.ts, Penpot `e--bq--code-inside`). The quote bar(s) run in a
  // left margin (painted on `.cm-code-quote-bars`, depth-driven inline style) and
  // the code card is inset to their right as a boxed, rounded `--paper-2` card.
  ".cm-code-quote-wrap": {
    position: "relative",
  },
  ".cm-code-quote-bars": {
    position: "absolute",
    left: "0",
    top: "0",
    bottom: "0",
    // width + bar gradient set inline by the widget (depth-dependent).
  },
  ".cm-code-quote-card": {
    position: "relative",
    backgroundColor: "var(--paper-2)",
    border: "1px solid var(--line-1, #e3e2dd)",
    borderRadius: "var(--radius-2, 6px)",
    padding: "14px 16px",
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
    lineHeight: "1.5",
    color: "var(--fg-1)",
    overflowX: "auto",
  },
  // Badge + copy cluster, pinned top-right inside the card (Penpot spec).
  ".cm-code-quote-badge": {
    position: "absolute",
    top: "10px",
    right: "12px",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
  },
  ".cm-code-quote-card:hover .cm-code-copy, .cm-code-quote-card .cm-code-copy:focus-visible": {
    opacity: "1",
  },

  // Horizontal-rule replacement widget from horizontal-rule.ts.
  ".cm-hr": {
    display: "inline-block",
    width: "100%",
    height: "1px",
    backgroundColor: "var(--line-1, #d8d5cc)",
    verticalAlign: "middle",
  },

  // Task checkbox widget from task-list.ts. Checked state: subtle accent-soft
  // fill + accent checkmark glyph (MYND-142) — reads as "done" without the
  // heavy solid fill the old diagonal-slash icon used.
  ".cm-task-checkbox": {
    position: "relative",
    display: "inline-block",
    width: "16px",
    height: "16px",
    // Gap to the label so a completed item's strikethrough never touches the box
    // (the strike itself also starts past the leading space — see task-list.ts).
    marginRight: "6px",
    border: "1.5px solid var(--line-2, #c8c7c1)",
    borderRadius: "var(--radius-1, 3px)",
    backgroundColor: "var(--paper, #faf8f3)",
    verticalAlign: "middle",
    cursor: "pointer",
    transition:
      "background-color var(--duration-fast, 120ms) var(--ease-standard, ease), border-color var(--duration-fast, 120ms) var(--ease-standard, ease)",
  },
  ".cm-task-checkbox-checked": {
    backgroundColor: "var(--accent-soft, #e8edf5)",
    borderColor: "var(--accent, #2c4a7a)",
  },
  // Checkmark drawn with borders (not a glyph, to avoid font-metric drift) and
  // centered with absolute positioning + transform — deterministic regardless
  // of the box's content-box quirks. translateY is biased up slightly so the
  // tick reads optically centered (its visual mass hangs low-left).
  ".cm-task-checkbox-checked::after": {
    content: '""',
    position: "absolute",
    top: "50%",
    left: "50%",
    width: "4px",
    height: "8px",
    boxSizing: "border-box",
    borderStyle: "solid",
    borderColor: "var(--accent, #2c4a7a)",
    borderWidth: "0 2px 2px 0",
    transform: "translate(-50%, -60%) rotate(45deg)",
  },
  // Completed-todo label: struck through + muted so it recedes from active items.
  ".cm-task-done-label": {
    textDecoration: "line-through",
    textDecorationColor: "var(--line-3, #a3a29c)",
    color: "var(--fg-3)",
  },

  // Wikilink chip widget from wikilink/chip-widget.ts.
  ".cm-wikilink-chip": {
    display: "inline-block",
    padding: "2px 8px",
    margin: "0 1px",
    borderRadius: "var(--radius-2, 6px)",
    backgroundColor: "var(--paper-2, #f3f1eb)",
    border: "1px solid var(--line-1, #d8d5cc)",
    color: "var(--fg-1)",
    fontWeight: "500",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    cursor: "pointer",
    verticalAlign: "baseline",
    // `text-indent` is inherited and applies to an inline-block's own first
    // line. Inside a `.cm-list-item-line` (which sets `text-indent: -1.5em`
    // for its hanging indent) the chip would otherwise shift its label ~1.5em
    // left, escaping the pill. Reset it so the label stays centered in the box.
    textIndent: "0",
  },
  ".cm-wikilink-chip:hover": {
    backgroundColor: "var(--paper-3, #ece9e2)",
  },
  ".cm-wikilink-chip-embed": {
    backgroundColor: "var(--paper-3, #ece9e2)",
    fontStyle: "italic",
  },
  // §5.3 broken-link styling (MYND-37/83): a wikilink whose target matches no
  // note — faded foreground, italic, no underline. Same chip surface as the
  // default (background/border/radius unchanged) so only the text reads "dead".
  ".cm-wikilink-chip-broken": {
    color: "var(--fg-3)",
    fontStyle: "italic",
    textDecoration: "none",
  },
  // Inline #tag chip (tag-system #3 / MYND-45) — derived from the single TS-5
  // tag-pill token (`src/notes/tagPillToken.ts`) so the editor chip and the
  // browser's pill rows never drift. Pill shape distinguishes a tag from a
  // wikilink chip.
  ...tagChipCmTheme(),
  // Generic tooltip surface (Myne design system). CM6's default `.cm-tooltip`
  // is a light box that clashes with the dark editor; bring it onto the paper
  // surface. The autocomplete tooltip's 2-class rule (`.cm-tooltip-autocomplete`)
  // is more specific and still wins for itself.
  ".cm-tooltip": {
    backgroundColor: "var(--paper, #faf8f3)",
    border: "1px solid var(--line-2, #c8c7c1)",
    borderRadius: "var(--radius-2, 6px)",
    boxShadow: "var(--shadow-2, 0 4px 12px rgba(0,0,0,0.08))",
    color: "var(--fg-1)",
  },
  // §6.2 hover-tooltip R1 content — the inner text on the `.cm-tooltip` surface.
  ".cm-wikilink-hover": {
    padding: "4px 8px",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    color: "var(--fg-2)",
    whiteSpace: "nowrap",
  },

  // Footnotes (MYND-153) — decorations/footnote.ts.
  // Inline `[^N]` reference marker: a raised, smaller, link-colored glyph; the
  // `[^` `]` brackets are hidden off-cursor via Decoration.replace. Clickable
  // (jumps to the definition), so a pointer cursor reads the affordance.
  ".cm-footnote-ref": {
    verticalAlign: "super",
    fontSize: "0.75em",
    lineHeight: "0",
    color: "var(--accent, #2c4a7a)",
    cursor: "pointer",
  },
  // Orphan reference (no matching definition): muted error tint, still raised.
  ".cm-footnote-ref-orphan": {
    color: "var(--danger, #8a2a23)",
    opacity: "0.8",
  },
  // In-source `[^N]: …` definition line, de-emphasized off-cursor (left in
  // place, never moved/deleted — §6 C1). Reveals at full prominence when the
  // cursor is on its line (the mark lifts).
  ".cm-footnote-def": {
    color: "var(--fg-3, #6b6a64)",
    fontSize: "0.92em",
  },
  // The definition's identifier rendered as a superscript marker (brackets +
  // colon hidden off-cursor) so each in-source definition is identifiable
  // without showing the raw `[^N]:` syntax. Mirrors the inline reference marker
  // but is not itself a click target.
  ".cm-footnote-def-marker": {
    verticalAlign: "super",
    fontSize: "0.75em",
    lineHeight: "0",
    color: "var(--accent, #2c4a7a)",
    marginRight: "0.25em",
  },

  // EOD "Footnotes" block widget — a derived read-only VIEW appended at document
  // end. The source definition lines stay byte-stable; this list never writes.
  ".cm-footnote-list": {
    paddingTop: "28px",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    lineHeight: "1.6",
    color: "var(--fg-2)",
  },
  ".cm-footnote-list-rule": {
    height: "1px",
    backgroundColor: "var(--line-1, #e3e2dd)",
    margin: "0 0 12px 0",
  },
  ".cm-footnote-list-heading": {
    fontSize: "11px",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--fg-3, #6b6a64)",
    marginBottom: "8px",
  },
  // Two-column grid so every entry's body text starts at the same x regardless
  // of identifier width (col 1 sizes to the widest marker — fixes the `1` vs
  // `long-note` misalignment). `.cm-footnote-item` is display:contents so its
  // marker + body become the grid cells.
  ".cm-footnote-list-items": {
    listStyle: "none",
    margin: "0",
    padding: "0",
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    columnGap: "10px",
    rowGap: "6px",
    alignItems: "baseline",
  },
  ".cm-footnote-item": {
    display: "contents",
  },
  // The identifier (the "label": 1 / long-note / final-note) reads as a distinct
  // anchor — monospace + accent — so it's unmistakably the footnote KEY, not part
  // of the sans body prose next to it (which previously shared the muted grey).
  ".cm-footnote-item-marker": {
    textAlign: "right",
    whiteSpace: "nowrap",
    fontFamily: "var(--font-mono)",
    fontSize: "0.85em",
    fontWeight: "600",
    color: "var(--accent, #2c4a7a)",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-footnote-item-body": {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    minWidth: "0", // let the text wrap inside the grid column
  },
  ".cm-footnote-item-text": {
    flex: "1 1 auto",
  },
  // Unreferenced (orphan) definition badge — amber, low-key.
  ".cm-footnote-item-badge": {
    flex: "0 0 auto",
    fontSize: "10px",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "var(--warning, #8a6a1f)",
    backgroundColor: "var(--warning-soft, #f5efde)",
    borderRadius: "var(--radius-1, 3px)",
    padding: "1px 6px",
  },
  // Back-affordance (↩) to the originating reference.
  ".cm-footnote-item-backref": {
    flex: "0 0 auto",
    color: "var(--accent, #2c4a7a)",
    cursor: "pointer",
    userSelect: "none",
  },

  // In-note find matches (MYND-175). The @codemirror/search engine decorates
  // every query match with `.cm-searchMatch` and the current/active one with
  // `.cm-searchMatch-selected`. Per the approved Penpot legend: all matches get
  // a quiet `--accent-soft` wash; the current match gets a denser accent tint
  // plus a 1px `--accent` ring. The denser tint is derived from existing tokens
  // via `color-mix` (so it themes automatically — no new token needed); if a
  // WebView lacks `color-mix`, the fill is simply dropped and the ring alone
  // still distinguishes the current match.
  ".cm-searchMatch": {
    backgroundColor: "var(--accent-soft, #e8edf5)",
    borderRadius: "2px",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--accent, #2c4a7a) 22%, var(--paper, #fbfbfa))",
    outline: "1px solid var(--accent, #2c4a7a)",
    outlineOffset: "-1px",
    borderRadius: "2px",
  },

  // Docked find panel chrome. The find bar provides its own `--paper` fill and
  // `--line-1` bottom hairline (`.cm-find-bar` in floating-styles.ts), so reset
  // CM's default panel background/border to avoid a double surface. Find is the
  // only editor panel, so scoping this to `.cm-panels` is safe.
  ".cm-panels": {
    backgroundColor: "transparent",
    color: "var(--fg-1)",
  },
  ".cm-panels.cm-panels-top": {
    borderBottom: "none",
    // Opaque fill (MYND-299 QA): the find bar is a sticky top panel inside a
    // padded scroll container, so a transparent panel let the scrolled note text
    // bleed through the strip above the bar. Match the bar's own `--paper` so the
    // whole top-panel region is solid — no content shows behind it.
    backgroundColor: "var(--paper)",
  },

  // Attachment embeds (MYND-164 / 147 / 149) — decorations/attachment-embed.ts,
  // decorations/image-url.ts, attachments/widgets.ts. The design pass uses raw
  // hex (not tokens) for the chip palette; matched exactly here.
  //
  // Inline image / PDF frame: 1px hairline, radius 6, neutral placeholder fill,
  // muted filename caption.
  ".cm-attachment-frame": {
    display: "inline-flex",
    flexDirection: "column",
    gap: "4px",
    maxWidth: "320px",
    verticalAlign: "top",
    // No frame: the image renders directly on the editor surface — no white
    // border / background / padding (dogfooding feedback). The `<img>` itself
    // keeps a subtle radius (.cm-attachment-img).
    // Vertical breathing room so two attachments rendered back-to-back are
    // visually separated. Token-based block spacing, `--space-3` rhythm.
    margin: "var(--space-3, 10px) 0",
  },
  ".cm-attachment-img": {
    display: "block",
    maxWidth: "100%",
    height: "auto",
    borderRadius: "4px",
  },
  // (Filename caption removed in the editor embed — dogfooding fix #2. The
  // media renders alone; the library keeps filenames, out of scope here.)
  // Inline scrollable multi-page reader: bounded box, the pages stack inside and
  // scroll. No white frame (consistent with the inline image rendering directly
  // on the surface). The scroller IS the IntersectionObserver root.
  ".cm-attachment-pdf-scroller": {
    display: "block",
    maxWidth: "320px",
    width: "320px",
    maxHeight: "min(70vh, 520px)",
    overflowY: "auto",
    borderRadius: "4px",
  },
  // One stacked page. A subtle gap between pages; each page's canvas fills the
  // page width. Placeholder background is the neutral paper tone until the lazy
  // render swaps in the canvas.
  // Small "Loading…" chip shown inside the (always-visible) scroller until the
  // document loads + the first page paints. Quiet, centered, no spinner.
  ".cm-attachment-pdf-loading": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "120px",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    color: "var(--fg-3, #6b6a64)",
    letterSpacing: "0.01em",
  },
  // One stacked page. An UNRENDERED placeholder reads as a muted "pending page"
  // outline on the dark surface — a subtle dashed/translucent frame, NOT a solid
  // white block, so a not-yet-painted page reads as pending rather than broken.
  ".cm-attachment-pdf-page": {
    display: "block",
    marginBottom: "var(--space-2, 8px)",
    backgroundColor: "rgba(255, 255, 255, 0.02)",
    border: "1px dashed var(--line-1, #e3e2dd)",
    borderRadius: "4px",
    overflow: "hidden",
  },
  // Once the real canvas swaps in, drop the pending outline (the canvas is the
  // page now) and seat it on the neutral paper tone.
  ".cm-attachment-pdf-page-rendered": {
    backgroundColor: "var(--paper-2, #f3f1eb)",
    border: "1px solid transparent",
  },
  ".cm-attachment-pdf-page:last-child": {
    marginBottom: "0",
  },
  ".cm-attachment-pdf-page-canvas": {
    display: "block",
    maxWidth: "100%",
  },

  // Clean in-flight progress chip (dogfooding fix #4) — replaces the struck /
  // tombstone-borrowing loading style. A quiet label + an indeterminate
  // hairline; reads as "in progress", visually distinct from the deleted/broken
  // tombstone. NO spinner, NO struck text, NO danger styling.
  ".cm-attachment-progress": {
    display: "inline-flex",
    flexDirection: "column",
    gap: "5px",
    alignItems: "stretch",
    minWidth: "104px",
    padding: "2px",
  },
  ".cm-attachment-progress-label": {
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    color: "var(--fg-3, #6b6a64)",
    letterSpacing: "0.01em",
  },
  ".cm-attachment-progress-bar": {
    position: "relative",
    display: "block",
    height: "2px",
    borderRadius: "1px",
    overflow: "hidden",
    backgroundColor: "var(--line-1, #e3e2dd)",
  },
  // Indeterminate moving segment — a subtle accent hairline sweeping across the
  // track. Pure CSS keyframes (defined globally below); no spinner glyph.
  ".cm-attachment-progress-bar::after": {
    content: '""',
    position: "absolute",
    top: "0",
    left: "0",
    height: "100%",
    width: "40%",
    borderRadius: "1px",
    backgroundColor: "var(--accent, #2c4a7a)",
    animation: "cm-attachment-progress-indeterminate 1.1s ease-in-out infinite",
  },
  ".cm-attachment-pdf-fallback": {
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "6px",
    color: "#6b6a64",
  },
  ".cm-attachment-pdf-fallback-label": {
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    letterSpacing: "0.06em",
    color: "#6b6a64",
  },

  // Non-fetching `![](url)` / `![][ref]` chip — NEUTRAL family (per the design
  // pass: not accent). radius 6, padding 3/8, flex row gap 6, 1px inner stroke.
  ".cm-attachment-url-chip": {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "3px 8px",
    borderRadius: "6px",
    backgroundColor: "#f4f4f2",
    border: "1px solid #e3e2dd",
    color: "#1a1a17",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    fontWeight: "500",
    verticalAlign: "baseline",
    cursor: "default",
  },
  ".cm-attachment-url-chip-label": {
    whiteSpace: "nowrap",
  },

  // Tombstone — deleted (muted image-off + struck filename) vs broken (danger
  // tint, like cm-footnote-ref-orphan). Shared visual family with the library.
  ".cm-attachment-tombstone": {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "3px 8px",
    borderRadius: "6px",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    fontWeight: "500",
    verticalAlign: "baseline",
    cursor: "default",
  },
  ".cm-attachment-tombstone-deleted": {
    backgroundColor: "#f4f4f2",
    border: "1px solid #e3e2dd",
    color: "#6b6a64",
  },
  ".cm-attachment-tombstone-deleted .cm-attachment-tombstone-label": {
    textDecoration: "line-through",
    textDecorationColor: "var(--line-2, #c8c7c1)",
  },
  ".cm-attachment-tombstone-broken": {
    // danger muted tint, mirroring the footnote orphan treatment.
    backgroundColor: "color-mix(in srgb, var(--danger, #8a2a23) 8%, #f4f4f2)",
    border: "1px solid color-mix(in srgb, var(--danger, #8a2a23) 22%, #e3e2dd)",
    color: "var(--danger, #8a2a23)",
  },
  ".cm-attachment-tombstone-label": {
    whiteSpace: "nowrap",
  },

  // Generic file-card (MYND-173): a non-renderable attachment (.docx/.zip/…)
  // shown as a compact, export-only card — icon + filename + "type · size" +
  // a "⋯" overflow menu. Inline-flex like the image/PDF frame, with a hairline
  // card surface (the generic file has nothing to render onto the surface).
  ".cm-attachment-file-card": {
    display: "inline-flex",
    alignItems: "center",
    gap: "10px",
    maxWidth: "360px",
    padding: "8px 10px",
    backgroundColor: "var(--bg-2, #f4f4f2)",
    border: "1px solid var(--line-1, #e3e2dd)",
    borderRadius: "var(--radius-2, 6px)",
    verticalAlign: "top",
    margin: "var(--space-3, 10px) 0",
    fontFamily: "var(--font-sans)",
    cursor: "default",
  },
  ".cm-attachment-file-card-icon": {
    flexShrink: 0,
    color: "var(--fg-3, #6b6a64)",
  },
  ".cm-attachment-file-card-text": {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    minWidth: 0, // allow the name to ellipsis instead of overflowing the card
    flex: "1 1 auto",
  },
  ".cm-attachment-file-card-name": {
    color: "var(--fg-1, #1a1a17)",
    fontSize: "13px",
    fontWeight: "500",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  ".cm-attachment-file-card-meta": {
    color: "var(--fg-3, #6b6a64)",
    fontSize: "11px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  ".cm-attachment-file-card-menuwrap": {
    position: "relative",
    flexShrink: 0,
  },
  ".cm-attachment-file-card-menubtn": {
    appearance: "none",
    border: "none",
    background: "transparent",
    color: "var(--fg-3, #6b6a64)",
    cursor: "pointer",
    fontSize: "16px",
    lineHeight: "1",
    padding: "2px 4px",
    borderRadius: "var(--radius-1, 4px)",
  },
  ".cm-attachment-file-card-menubtn:hover": {
    backgroundColor: "var(--paper-2, #f3f1eb)",
    color: "var(--fg-1, #1a1a17)",
  },
  // NOTE: the overflow MENU + its items are body-mounted (portaled out of the
  // editor so `.cm-scroller` can't clip them), so their styles live in the
  // global stylesheet (`attachments/styles.ts`), not this `.cm-editor`-scoped
  // theme. Only the in-card button (`-menubtn`) is styled here.

  // Inline audio player (voice notes, MYND-259) — a sibling of the file-card,
  // same surface tokens. Circular accent play button, a seek track (the
  // waveform overlays this track in a later slice), and a mono time readout.
  ".cm-attachment-audio": {
    display: "inline-flex",
    flexDirection: "column",
    gap: "6px",
    width: "360px",
    maxWidth: "360px",
    padding: "10px 12px",
    backgroundColor: "var(--bg-2, #f4f4f2)",
    border: "1px solid var(--line-1, #e3e2dd)",
    borderRadius: "var(--radius-2, 6px)",
    verticalAlign: "top",
    margin: "var(--space-3, 10px) 0",
    fontFamily: "var(--font-sans)",
    cursor: "default",
  },
  // Filename — top-left of the card.
  ".cm-attachment-audio-name": {
    fontSize: "12px",
    fontWeight: "500",
    color: "var(--fg-1, #1a1a17)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "100%",
  },
  // Middle row: play button + waveform + overflow, vertically centered.
  ".cm-attachment-audio-row": {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  ".cm-attachment-audio-play": {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "32px",
    height: "32px",
    padding: "0",
    border: "none",
    borderRadius: "999px",
    backgroundColor: "var(--accent, #2c4a7a)",
    color: "var(--accent-on, #fff)",
    cursor: "pointer",
  },
  ".cm-attachment-audio-play svg": {
    width: "15px",
    height: "15px",
  },
  ".cm-attachment-audio-play:hover": {
    opacity: "0.9",
  },
  ".cm-attachment-audio-play:focus-visible": {
    outline: "2px solid var(--accent, #2c4a7a)",
    outlineOffset: "2px",
  },
  ".cm-attachment-audio-track": {
    position: "relative",
    flex: "1 1 auto",
    minWidth: 0,
    height: "30px",
    borderRadius: "var(--radius-1, 4px)",
    cursor: "pointer",
  },
  // Thin centered baseline (the unplayed seek rail), shown until the waveform
  // bars decode in.
  ".cm-attachment-audio-track::before": {
    content: '""',
    position: "absolute",
    left: "0",
    right: "0",
    top: "50%",
    height: "3px",
    transform: "translateY(-50%)",
    borderRadius: "999px",
    backgroundColor: "var(--line-2, #c8c7c1)",
  },
  ".cm-attachment-audio-track:focus-visible": {
    outline: "2px solid var(--accent, #2c4a7a)",
    outlineOffset: "3px",
  },
  ".cm-attachment-audio-fill": {
    position: "absolute",
    left: "0",
    top: "50%",
    height: "3px",
    transform: "translateY(-50%)",
    width: "0%",
    borderRadius: "999px",
    backgroundColor: "var(--accent, #2c4a7a)",
  },
  ".cm-attachment-audio-thumb": {
    position: "absolute",
    top: "50%",
    left: "0%",
    width: "10px",
    height: "10px",
    marginLeft: "-5px",
    borderRadius: "999px",
    backgroundColor: "var(--accent, #2c4a7a)",
    transform: "translateY(-50%)",
    boxShadow: "var(--shadow-1, 0 1px 3px rgba(0,0,0,0.08))",
  },
  // Waveform mode: the bar grid replaces the plain rail (hide baseline + fill).
  ".cm-attachment-audio-wave": {
    position: "absolute",
    inset: "0",
    display: "flex",
    alignItems: "center",
    gap: "2px",
  },
  ".cm-attachment-audio-track-wave::before": {
    display: "none",
  },
  ".cm-attachment-audio-track-wave .cm-attachment-audio-fill": {
    display: "none",
  },
  ".cm-attachment-audio-track-wave .cm-attachment-audio-thumb": {
    display: "none",
  },
  ".cm-attachment-audio-bar": {
    flex: "1 1 0",
    minWidth: "2px",
    height: "30%",
    borderRadius: "1px",
    backgroundColor: "var(--line-3, #a8a7a1)",
    alignSelf: "center",
  },
  ".cm-attachment-audio-bar-played": {
    backgroundColor: "var(--accent, #2c4a7a)",
  },
  ".cm-attachment-audio-time": {
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    color: "var(--fg-3, #6b6a64)",
    whiteSpace: "nowrap",
  },

  // Autocomplete tooltip (emoji `:shortcode`, MYND-156). CM6 mounts the
  // completion tooltip inside the editor's tooltip layer, so its `.cm-tooltip*`
  // classes ARE reachable by this theme (unlike the body-mounted slash menu).
  // Bring it into the design system: paper surface, hairline + shadow, sans
  // type, accent-soft active row. The glyph (`detail`) sits muted on the right.
  ".cm-tooltip.cm-tooltip-autocomplete": {
    backgroundColor: "var(--paper, #faf8f3)",
    border: "1px solid var(--line-2, #c8c7c1)",
    borderRadius: "var(--radius-2, 6px)",
    boxShadow: "var(--shadow-2, 0 4px 12px rgba(0,0,0,0.08))",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    maxHeight: "16em",
  },
  ".cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "5px 10px",
    color: "var(--fg-1)",
    lineHeight: "1.3",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent-soft, #e8edf5)",
    color: "var(--fg-1)",
  },
  ".cm-tooltip-autocomplete .cm-completionLabel": {
    flex: "1 1 auto",
    fontFamily: "var(--font-mono)",
  },
  ".cm-tooltip-autocomplete .cm-completionMatchedText": {
    textDecoration: "none",
    fontWeight: "700",
    color: "var(--accent, #2c4a7a)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionMatchedText": {
    color: "var(--accent, #2c4a7a)",
  },
  ".cm-tooltip-autocomplete .cm-completionDetail": {
    flex: "0 0 auto",
    fontStyle: "normal",
    fontSize: "15px",
    color: "var(--fg-2)",
  },

  // Floating UI (slash menu / selection toolbar / URL overlay) styles
  // live in `floating-styles.ts` as global CSS — they mount to
  // document.body to escape ancestor containing-block context, so CM6's
  // theme scoping (which prefixes all selectors with the editor's theme
  // class) doesn't reach them.
});
