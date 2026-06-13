// Myne editor theme — maps all CodeMirror 6 CSS classes used by decorations
// + floating surfaces to design tokens via `var(--*)` CSS variable
// references.
//
// PRD `editor-mvp-baseline` stories 47-49, 67. No hardcoded color values;
// OS `prefers-color-scheme` switching happens at the CSS variable layer
// (`docs/design/colors_and_type.css`) — the editor extension inherits
// automatically. No JS-side light/dark mode tracking.

import { EditorView } from "@codemirror/view";

export const myneTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--fg-1)",
    fontFamily: "var(--font-mono)",
    fontSize: "14px",
    lineHeight: "1.7",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "inherit",
  },
  ".cm-content": {
    caretColor: "var(--accent, #2c4a7a)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--accent, #2c4a7a)",
  },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--paper-3, #ece9e2)",
  },

  // Headings — apply via `Decoration.line` from heading.ts.
  ".cm-h1": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "28px",
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
    fontSize: "22px",
    fontWeight: "700",
    lineHeight: "1.3",
  },
  ".cm-h3": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "18px",
    fontWeight: "600",
    lineHeight: "1.35",
  },
  ".cm-h4": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "16px",
    fontWeight: "600",
    lineHeight: "1.4",
  },
  ".cm-h5": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "14px",
    fontWeight: "600",
    lineHeight: "1.4",
  },
  ".cm-h6": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "13px",
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
  ".cm-table-scroll": {
    display: "block",
    overflowX: "auto",
    maxWidth: "100%",
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
  },
  ".cm-table th": {
    fontWeight: "700",
    backgroundColor: "var(--paper-3, #ece9e2)",
  },
  // Zebra striping on alternating body rows (PRD story 8). Lighter than the
  // header fill so the header still reads as distinct.
  ".cm-table-row-alt td": {
    backgroundColor: "var(--paper-2, #f3f1eb)",
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
