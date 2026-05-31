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
  ".cm-table-scroll": {
    display: "block",
    overflowX: "auto",
    maxWidth: "100%",
    margin: "10px 0",
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
  // Editing-state line rounding (raw fence shown): top/bottom body lines round.
  ".cm-code-card-top": {
    borderTop: "1px solid var(--line-1)",
    borderTopLeftRadius: "var(--radius-2, 6px)",
    borderTopRightRadius: "var(--radius-2, 6px)",
    paddingTop: "8px",
  },
  ".cm-code-card-bottom": {
    borderBottom: "1px solid var(--line-1)",
    borderBottomLeftRadius: "var(--radius-2, 6px)",
    borderBottomRightRadius: "var(--radius-2, 6px)",
    paddingBottom: "8px",
  },
  // Away-state card-top bar widget (replaces the opening fence line); carries
  // the language badge top-right. Side + top borders + top radius continue the
  // card around the body lines below.
  ".cm-code-card-bar": {
    display: "flex",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: "10px",
    backgroundColor: "var(--paper-2)",
    borderLeft: "1px solid var(--line-1)",
    borderRight: "1px solid var(--line-1)",
    borderTop: "1px solid var(--line-1)",
    borderTopLeftRadius: "var(--radius-2, 6px)",
    borderTopRightRadius: "var(--radius-2, 6px)",
    minHeight: "26px",
    padding: "4px 16px",
    boxSizing: "border-box",
  },
  ".cm-code-card-bar-full": {
    borderBottom: "1px solid var(--line-1)",
    borderBottomLeftRadius: "var(--radius-2, 6px)",
    borderBottomRightRadius: "var(--radius-2, 6px)",
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
    marginTop: "28px",
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
  ".cm-footnote-item-marker": {
    textAlign: "right",
    whiteSpace: "nowrap",
    color: "var(--fg-3, #6b6a64)",
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

  // Floating UI (slash menu / selection toolbar / URL overlay) styles
  // live in `floating-styles.ts` as global CSS — they mount to
  // document.body to escape ancestor containing-block context, so CM6's
  // theme scoping (which prefixes all selectors with the editor's theme
  // class) doesn't reach them.
});
