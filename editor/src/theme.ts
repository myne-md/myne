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
import { taskChipCmTheme } from "@myne/editor/host/notes/taskChipToken";

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
    // The floor for "the editor never scrolls sideways" (myne-md/myne#630).
    //
    // `EditorView.lineWrapping` is mounted, so TEXT already wraps; what used to
    // scroll was a widget that would not shrink. CodeMirror's base theme gives
    // `.cm-scroller` `overflow-x: auto` and `.cm-content` `flex-shrink: 0` with
    // the flex default `min-width: auto`, so one unshrinkable descendant floors
    // the content width and turns the whole note into a horizontal scroller,
    // which is what the frontmatter Properties grid and the fixed-width
    // attachment widgets were doing. Those are fixed at their own rules; this
    // is the guarantee that the NEXT one cannot reintroduce the swipe.
    //
    // Nothing legitimately wide is lost, because every wide construct in the
    // editor already scrolls inside its own box: `.cm-table-scroll` /
    // `.cm-table-editable`, `.cm-mermaid-card`, `.cm-math-block`,
    // `.cm-code-quote-card`. A new one owes the same containment, and this rule
    // is what makes forgetting it visible (clipped) rather than silent (the
    // whole page drifts sideways).
    overflowX: "hidden",
  },
  ".cm-content": {
    caretColor: "var(--accent, #2c4a7a)",
    // Lay trailing spaces out instead of hanging them (myne-md/myne#657).
    //
    // CodeMirror's base theme sets `.cm-content` to `white-space: pre` and only
    // reaches `break-spaces` through the `.cm-lineWrapping` class that
    // `EditorView.lineWrapping` adds. Under `pre-wrap` a trailing space hangs
    // at end of line (no width, caret does not advance) while the document
    // keeps the byte, which is exactly the reported live-view/raw asymmetry.
    // Pin `break-spaces` here explicitly so the layout does not depend on the
    // base theme's class surviving, and on `.cm-line` below so the line itself
    // resolves to it. Same value the base theme carries, so nothing visual
    // changes; this only stops it from drifting.
    whiteSpace: "break-spaces",
    // Fill the scroller so the empty area below the text is part of the editable
    // surface — clicking there reaches the editor (and lands the caret on the
    // last line, MYND-162 feedback) instead of being dead space.
    minHeight: "100%",
    // The list metrics, declared ONCE and read from both sides of the DOM.
    //
    // `decorations/list.ts` builds each list line's hanging indent out of these
    // (MYND-626, myne-md/myne#594): the marker's own width plus one step per
    // nesting level, with the source's leading whitespace hidden so the column is
    // exact rather than measured in `ch` against a space that is not `ch` wide.
    // They live here rather than as JS constants mirroring the rules below,
    // because that mirror only had to be right to LOOK right until #594 made the
    // indent arithmetic depend on it, after which editing `.cm-task-checkbox`'s
    // `margin-right` would have silently misaligned every wrapped task row. A
    // custom theme can move them for the same reason.
    "--cm-list-marker-bullet": "1.4ch", // `.cm-list-bullet` 1ch + 0.4ch margin
    "--cm-list-marker-task": "22px", // `.cm-task-checkbox` 16px + 6px margin
    "--cm-list-indent-step": "1.5em", // one level of nesting
  },
  "&.cm-focused": {
    outline: "none",
  },
  // Line-level twin of the `.cm-content` rule above (myne-md/myne#657): the
  // base theme sets no `white-space` on `.cm-line` itself, so the line only
  // resolves to `break-spaces` by inheritance. State it directly.
  ".cm-line": {
    whiteSpace: "break-spaces",
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
  // vim-keyboard-mode (MYND-313): the vim engine draws its normal-mode BLOCK
  // cursor as `.cm-fat-cursor` and hard-codes it to `#ff9696` — a colour that
  // belongs to no Myne palette and reads as a foreign artefact in both themes.
  // Re-point it at the same accent token the line cursor uses, so the two cursor
  // shapes are visibly the same editor.
  //
  // Selector specificity is load-bearing here: the engine ships its rules at
  // `Prec.highest`, so these must OUT-SPECIFY `.cm-fat-cursor` (0,1,0) and
  // `&:not(.cm-focused) .cm-fat-cursor` (0,3,0) rather than merely come later in
  // source order. Hence the `.cm-focused` qualifier and the explicit
  // primary/secondary cursor classes.
  "&.cm-focused .cm-fat-cursor": {
    background: "var(--accent, #2c4a7a)",
  },
  "&:not(.cm-focused) .cm-fat-cursor.cm-cursor-primary": {
    outline: "solid 1px var(--accent, #2c4a7a)",
  },
  "&:not(.cm-focused) .cm-fat-cursor.cm-cursor-secondary": {
    outline: "solid 1px var(--accent, #2c4a7a)",
  },
  // Text selection (double-click word, drag, Cmd/Ctrl+A). A neutral `--paper-3`
  // fill is invisible in dark mode, so tint with the accent (flips per theme, so
  // the wash stays visible in both light and dark). BOTH focus states are styled:
  // CodeMirror's built-in UNFOCUSED selection is a light wash that washes out
  // dark-mode text the moment focus leaves the editor (e.g. the floating
  // selection toolbar opens) — restyle it too, dim but still contrast-safe, so a
  // selection stays readable regardless of focus. The focused wash is fuller,
  // keeping a subtle "focus is here" cue.
  // Theme-tuned via the `--selection-bg` token (a TRANSLUCENT accent, defined
  // per theme in tokens.css) — NOT `color-mix()`, which older WKWebView drops,
  // voiding the rule and leaving an unreadable default wash. Focused AND
  // unfocused use the SAME value so opening the floating toolbar (which blurs
  // the editor) never washes the selection out. The rgba fallback covers a
  // WebView with no `--selection-bg` in scope.
  // `!important` is load-bearing: CodeMirror's baseTheme styles the selection
  // with HIGHER-specificity selectors (`&.cm-focused > .cm-scroller >
  // .cm-selectionLayer .cm-selectionBackground` and a separate unfocused rule),
  // which otherwise win over a plain `.cm-selectionBackground` rule — leaving the
  // library's unreadable default wash (the bug). `!important` guarantees ours
  // applies in both focus states.
  // Only the DRAWN layer. The bare `::selection` that used to ride along in this
  // selector list is gone: `drawSelection` already paints the selection itself
  // and zeroes the native one inside `.cm-line` (both the compound and the
  // descendant form, `Prec.highest` + `!important`), so a second rule
  // re-asserting a native `::selection` background across the whole editor
  // could only ever paint ON TOP of the drawn band — two washes over the same
  // text, in two tones. That is the double highlight.
  //
  // It is not needed for anything: the one place the drawn layer genuinely
  // cannot be seen is a fenced code card, whose opaque body paints over it, and
  // that case has its own deliberate carve-out below at a specificity chosen to
  // out-rank the upstream zeroing. Outside the editor, `tokens.css`'s global
  // `::selection` still styles ordinary UI text.
  ".cm-selectionBackground": {
    backgroundColor: "var(--selection-bg, rgba(44, 74, 122, 0.24)) !important",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--selection-bg, rgba(44, 74, 122, 0.24)) !important",
  },
  // Selection inside a fenced code-block card: the card paints an OPAQUE
  // `--paper-2` background on each body line (content layer), which sits ABOVE
  // CM's drawn selection layer and hides it — so a selection over code showed
  // nothing. Re-enable the NATIVE `::selection` for code-card lines (it paints on
  // the text, over the card bg). `drawSelection` zeroes native `::selection` with
  // a `Prec.highest` rule `.cm-line ::selection { transparent !important }`
  // (specificity 0,2,1 with the theme class); the COMPOUND `.cm-line.cm-code-card-body`
  // here is 0,3,1, so it out-specifies that important rule regardless of order.
  ".cm-line.cm-code-card-body::selection, .cm-line.cm-code-card-body ::selection": {
    backgroundColor: "var(--selection-bg, rgba(44, 74, 122, 0.24)) !important",
  },

  // Headings — apply via `Decoration.line` from heading.ts.
  ".cm-h1": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "2em",
    fontWeight: "var(--weight-bold)",
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
    fontWeight: "var(--weight-bold)",
    lineHeight: "1.3",
  },
  ".cm-h3": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "1.286em",
    fontWeight: "var(--weight-semibold)",
    lineHeight: "1.35",
  },
  ".cm-h4": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "1.143em",
    fontWeight: "var(--weight-semibold)",
    lineHeight: "1.4",
  },
  ".cm-h5": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "1em",
    fontWeight: "var(--weight-semibold)",
    lineHeight: "1.4",
  },
  ".cm-h6": {
    fontFamily: "var(--font-display, var(--font-sans))",
    fontSize: "0.929em",
    fontWeight: "var(--weight-semibold)",
    lineHeight: "1.4",
    color: "var(--fg-2)",
  },

  // Inline marks — text style classes from emphasis.ts / link.ts / inline-code.ts.
  ".cm-bold": { fontWeight: "var(--weight-bold)" },
  ".cm-italic": { fontStyle: "italic" },
  ".cm-strike": { textDecoration: "line-through" },
  // `unicode-bidi: isolate` (RTL, myne#172): a link's own text is a neutral run
  // as far as the surrounding paragraph's bidi ordering is concerned — isolating
  // it stops an intrinsically-LTR URL/label from visually reordering the RTL
  // text around it (the classic "link inside an Arabic sentence jumps" bug).
  ".cm-link": {
    textDecoration: "underline",
    color: "var(--accent, #2c4a7a)",
    unicodeBidi: "isolate",
  },
  // Clickable autolinks / bare URLs (MYND-150 + MYND-151) carry `data-cm-url`;
  // give them a pointer cursor so the open-on-click affordance reads. Regular
  // `[text](url)` links don't carry the attribute (click reveals source).
  ".cm-link[data-cm-url]": { cursor: "pointer" },
  ".cm-inline-code": {
    // Isolate code spans from paragraph bidi — an inline `code` run (often
    // identifiers, numbers, an account number) must not reorder its RTL context.
    unicodeBidi: "isolate",
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
  // `.cm-list-item-line` carries no metrics of its own: `decorations/list.ts`
  // styles every line it marks, inline and per line, from the custom properties
  // declared above. The class stays as the "this is a list line" hook.
  //
  // The `+ 6px` that decoration adds is CM's default `.cm-line` left padding: it
  // keeps the MARKER aligned with the body text column instead of hanging it at
  // the line's hard left edge: at x≈0 the top-level •/*/+ markers fell 6px into
  // the gutter and read as "no marker at all".

  // Live-collaboration awareness (live-collab, `collab-presence-ui`): a peer's
  // caret, its name label and their selection band. Every value binds a `var(*)`
  // token; the per-participant colour arrives as `--cm-awareness-color` (the widget
  // sets it to the peer's `var(--group-*)`). The label is ALWAYS drawn beside the
  // caret, so colour is never the sole channel. The caret's one-shot fade-in lives
  // as global `@keyframes` in `attachments/styles.ts` (the CM theme's StyleModule
  // cannot emit `@keyframes`) with a `prefers-reduced-motion` arm that removes it.
  ".cm-awareness-caret": {
    position: "relative",
    borderInlineStart: "2px solid var(--cm-awareness-color, var(--accent))",
    marginInline: "-1px",
    pointerEvents: "none",
  },
  ".cm-awareness-label": {
    position: "absolute",
    top: "-1.35em",
    insetInlineStart: "-2px",
    padding: "1px var(--space-1)",
    borderRadius: "var(--radius-1)",
    background: "var(--cm-awareness-color, var(--accent))",
    color: "var(--accent-on, #ffffff)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-xs, 10px)",
    fontWeight: "var(--weight-medium)",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  },
  ".cm-awareness-selection": {
    background:
      "color-mix(in srgb, var(--cm-awareness-color, var(--accent)) 30%, transparent)",
    borderBottom: "1px solid var(--cm-awareness-color, var(--accent))",
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

  // Colored highlights (MYND-637) reuse the `.cm-highlight` base (radius / padding
  // / ink) and override ONLY the wash, one class per colour — mirroring the
  // `.cm-embedded-html mark.hl-*` set below, same `--highlight-*` vars + own-colour
  // fallbacks. colored-highlight.ts paints the span `.cm-highlight cm-hl-X`, so the
  // caret-on `==` skin (rendered inside the span) inherits the wash automatically.
  ".cm-highlight.cm-hl-yellow": { backgroundColor: "var(--highlight, #f3e7c4)" },
  ".cm-highlight.cm-hl-green": { backgroundColor: "var(--highlight-green, #d8e9cf)" },
  ".cm-highlight.cm-hl-blue": { backgroundColor: "var(--highlight-blue, #d3e2ee)" },
  ".cm-highlight.cm-hl-pink": { backgroundColor: "var(--highlight-pink, #efd8e2)" },
  ".cm-highlight.cm-hl-purple": { backgroundColor: "var(--highlight-purple, #e2d8ee)" },
  ".cm-highlight.cm-hl-orange": { backgroundColor: "var(--highlight-orange, #f2ddc6)" },
  ".cm-highlight.cm-hl-red": { backgroundColor: "var(--highlight-red, #efd3d3)" },
  ".cm-highlight.cm-hl-teal": { backgroundColor: "var(--highlight-teal, #cfe6e2)" },
  ".cm-highlight.cm-hl-cyan": { backgroundColor: "var(--highlight-cyan, #cfe4ea)" },
  ".cm-highlight.cm-hl-lime": { backgroundColor: "var(--highlight-lime, #e0ecc4)" },
  ".cm-highlight.cm-hl-brown": { backgroundColor: "var(--highlight-brown, #e3d9cd)" },
  ".cm-highlight.cm-hl-grey": { backgroundColor: "var(--highlight-grey, #dedcd8)" },
  ".cm-highlight.cm-hl-indigo": { backgroundColor: "var(--highlight-indigo, #d6d8ee)" },
  // The `==` skin colored-highlight.ts reveals on cursor needs no rule of its own:
  // it renders inside the painted `.cm-highlight` span, so wash + ink inherit —
  // identical to a yellow `==text==`. The `cm-hl-eq` class stays as a DOM hook.

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
  // MYND-632's eight. Each fallback is that colour's OWN light value, matching
  // the five above — a shared fallback would render eight indistinguishable
  // washes wherever the stylesheet has not loaded, which is the exact failure
  // the palette exists to prevent.
  ".cm-embedded-html mark.hl-orange": {
    backgroundColor: "var(--highlight-orange, #f2ddc6)",
  },
  ".cm-embedded-html mark.hl-red": {
    backgroundColor: "var(--highlight-red, #efd3d3)",
  },
  ".cm-embedded-html mark.hl-teal": {
    backgroundColor: "var(--highlight-teal, #cfe6e2)",
  },
  ".cm-embedded-html mark.hl-cyan": {
    backgroundColor: "var(--highlight-cyan, #cfe4ea)",
  },
  ".cm-embedded-html mark.hl-lime": {
    backgroundColor: "var(--highlight-lime, #e0ecc4)",
  },
  ".cm-embedded-html mark.hl-brown": {
    backgroundColor: "var(--highlight-brown, #e3d9cd)",
  },
  ".cm-embedded-html mark.hl-grey": {
    backgroundColor: "var(--highlight-grey, #dedcd8)",
  },
  ".cm-embedded-html mark.hl-indigo": {
    backgroundColor: "var(--highlight-indigo, #d6d8ee)",
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
    fontWeight: "var(--weight-semibold)",
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

  // Malformed task-field value (MYND-614 task 8) — raw source text carrying a
  // subtle failure hint, the math-error treatment. Never a blank chip, never a
  // silently corrected value; the characters stay in place so the user can fix
  // them, and the span stays clickable.
  ".cm-task-field-invalid": {
    textDecoration: "underline dotted var(--fg-3, #6b6a64)",
    textDecorationSkipInk: "none",
    cursor: "pointer",
  },

  // The inline explanation for an anchorless `repeat` (myne#276). Quieter than
  // the text it follows — it is an aside about the line, not part of it — but
  // present without being hovered, which the `title` attribute alone was not.
  ".cm-task-field-hint": {
    marginInlineStart: "0.5em",
    fontSize: "0.85em",
    color: "var(--fg-3, #6b6a64)",
    fontStyle: "italic",
    userSelect: "none",
  },

  // Task-query block (MYND-617) — a live list where a code card would be. The
  // fill is neutral and the completed state is a filled box plus struck text:
  // the canon's no-green-check and no-state-as-fill rules apply here exactly as
  // they do in the panel, because it is the same list in a different frame.
  ".cm-task-query": {
    display: "block",
    padding: "8px 10px",
    margin: "6px 0",
    border: "1px solid var(--line-1, #d8d5cc)",
    borderRadius: "var(--radius-2, 6px)",
    // `--paper`, not `--paper-1`: the surface ramp's light end is the bare name
    // and `--paper-1` is declared nowhere, so this block rendered with no
    // background on all three clients while its two siblings above carried
    // fallbacks (myne-md/myne#478). Fallback added to match them.
    background: "var(--paper, #fbfbfa)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    lineHeight: "1.5",
  },
  ".cm-task-query-row": {
    display: "flex",
    alignItems: "flex-start",
    gap: "8px",
    padding: "3px 0",
  },
  ".cm-task-query-box": {
    flex: "0 0 auto",
    width: "13px",
    height: "13px",
    marginTop: "3px",
    borderRadius: "3px",
    border: "1px solid var(--line-2, #d8d5cc)",
    cursor: "pointer",
  },
  ".cm-task-query-box-done": {
    background: "var(--fg-3, #6b6a64)",
    borderColor: "var(--fg-3, #6b6a64)",
  },
  ".cm-task-query-box:focus-visible": {
    outline: "2px solid var(--accent)",
    outlineOffset: "1px",
  },
  ".cm-task-query-text": { flex: "1 1 auto", minWidth: "0", overflowWrap: "anywhere" },
  ".cm-task-query-text-done": {
    textDecoration: "line-through",
    color: "var(--fg-3, #6b6a64)",
  },
  ".cm-task-query-note": {
    flex: "0 0 auto",
    background: "none",
    border: "none",
    padding: "0",
    color: "var(--fg-3, #6b6a64)",
    fontFamily: "inherit",
    fontSize: "12px",
    cursor: "pointer",
    maxWidth: "160px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-task-query-empty, .cm-task-query-more": {
    color: "var(--fg-3, #6b6a64)",
    fontSize: "12px",
    padding: "2px 0",
  },
  // The refusal reads differently from an empty result on purpose: an empty
  // list that was actually a misread query sends the user hunting for tasks
  // that are really there.
  ".cm-task-query-refused": {
    color: "var(--fg-2, #4a4943)",
    fontSize: "12px",
    padding: "2px 0",
    borderLeft: "2px solid var(--line-2, #d8d5cc)",
    paddingLeft: "8px",
  },
  ".cm-task-query-dropped": {
    marginTop: "6px",
    color: "var(--fg-3, #6b6a64)",
    fontSize: "12px",
  },
  ".cm-task-query-dropped summary": { cursor: "pointer" },
  ".cm-task-query-dropped ul": { margin: "4px 0 0", paddingLeft: "18px" },

  // Inline tag-suggestion band (MYND-651) — a quiet row above the note body,
  // never a card. It appears without being asked for, so it reads as marginalia:
  // muted label, hairline chips, no fill, no accent colour. The solid/dashed
  // border is the whole visual vocabulary — solid means the tag already exists
  // in the vault, dashed means accepting it grows the vocabulary.
  ".cm-tag-suggestion-band": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    margin: "4px 0 10px",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    lineHeight: "1.5",
  },
  ".cm-tag-suggestion-label": {
    color: "var(--fg-3, #6b6a64)",
    fontSize: "11px",
    letterSpacing: "0.02em",
  },
  // `min-width: 0` and `max-width: 100%`, for the same reason the Properties
  // grid gained them (myne-md/myne#630): an `inline-flex` item in a wrapping
  // flex container has the flex default `min-width: auto`, so it floors at its
  // own min-content width and a long tag name would widen `.cm-content` past the
  // scroller. With the `.cm-scroller { overflow-x: hidden }` floor now in place
  // that shows up as a clip rather than a sideways swipe, which is the failure
  // the floor's own comment says it converts silence into.
  ".cm-tag-suggestion-chip": {
    display: "inline-flex",
    alignItems: "center",
    gap: "2px",
    padding: "1px 3px 1px 8px",
    border: "1px solid var(--line-1, #d8d5cc)",
    borderRadius: "var(--radius-1, 4px)",
    background: "transparent",
    minWidth: 0,
    maxWidth: "100%",
  },
  ".cm-tag-suggestion-chip > *": { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-tag-suggestion-chip-new": { borderStyle: "dashed" },
  ".cm-tag-suggestion-accept": {
    background: "none",
    border: "none",
    padding: "0",
    margin: "0",
    color: "var(--fg-2, #4a4943)",
    fontFamily: "inherit",
    fontSize: "12px",
    fontWeight: "var(--weight-medium)",
    cursor: "pointer",
  },
  ".cm-tag-suggestion-dismiss": {
    background: "none",
    border: "none",
    padding: "0 3px",
    margin: "0",
    color: "var(--fg-3, #6b6a64)",
    fontFamily: "inherit",
    fontSize: "12px",
    lineHeight: "1",
    cursor: "pointer",
  },
  ".cm-tag-suggestion-accept:focus-visible, .cm-tag-suggestion-dismiss:focus-visible": {
    outline: "2px solid var(--accent)",
    outlineOffset: "1px",
  },

  // Spell-check squiggle (MYND-264, SYNC-9) — a wavy red underline driven by
  // the `--danger` design token (no hex), tracking the glyphs via
  // text-decoration-skip-ink. Decoration-only overlay; never mutates the buffer.
  ".cm-spell-error": {
    textDecoration: "underline wavy var(--danger, #8a2a23)",
    textDecorationSkipInk: "none",
  },

  // Mermaid diagrams (MYND-49) — the rendered SVG sits on its own card that
  // follows the ACTIVE THEME (myne-md/myne#708 follow-up; this supersedes the
  // fixed-light clause of decision 0566). Card, chrome and mermaid's own palette
  // all bind to Myne tokens, so a dark or AMOLED theme gets a dark diagram rather
  // than a white panel. The outer `.cm-mermaid` is a transparent, measured spacer
  // (padding, not margin — see note above); the inner `.cm-mermaid-card` carries
  // the surface.
  //
  // "Fixed-light" is what the paragraph above has always claimed and what the ink
  // below has always been; the SURFACE had drifted to `var(--paper)`, which is
  // theme-aware, so in the dark and AMOLED themes the card was dark under ink
  // pinned at `#1a1a17` (myne-md/myne#629). `--diagram-surface` is the same
  // value in every theme block by construction. See its comment in tokens.css.
  //
  // `inline-block` + `max-width: 100%` + `overflow-x: auto` is the "scroll
  // inside the widget, never the editor" pattern `.cm-table-scroll` uses further
  // down, and it is load-bearing here now that the SVG carries a real pixel
  // width (`useMaxWidth: false`, render-mermaid.ts): a wide diagram must scroll
  // in this box rather than widen `.cm-content` and make the whole editor scroll
  // sideways (myne-md/myne#630).
  //
  // NOT `contain: inline-size`, which `.cm-table-editable` does use. That
  // property means "size the inline axis as if the box were empty", which is
  // right for a block box filling its column and catastrophic for a shrink-to-fit
  // one: an `inline-block` with no width would collapse to nothing. The card
  // wants to be exactly as wide as its diagram, capped at the column, which is
  // what `max-width` alone gives.
  ".cm-mermaid": {
    display: "block",
    textAlign: "center",
    padding: "8px 0",
  },
  ".cm-mermaid-card": {
    display: "inline-block",
    maxWidth: "100%",
    boxSizing: "border-box",
    overflowX: "auto",
    backgroundColor: "var(--paper)",
    border: "1px solid var(--line-1)",
    borderRadius: "var(--radius-2, 6px)",
    padding: "16px",
    color: "var(--ink-1)",
  },
  ".cm-mermaid-fallback .cm-mermaid-card": {
    display: "block",
  },
  ".cm-mermaid-fallback pre": {
    margin: "0",
    textAlign: "left",
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    color: "var(--ink-1)",
    overflowX: "auto",
  },
  // The render failure's own reason, under the monospace fallback. Before
  // myne-md/myne#629 the `error` string was discarded outright: a diagram that
  // failed to parse showed its source and said nothing about why, so a typo in a
  // node id and a mermaid version that does not know the diagram type looked
  // identical.
  ".cm-mermaid-error": {
    margin: "8px 0 0",
    textAlign: "left",
    fontFamily: "var(--font-sans)",
    fontSize: "0.85em",
    // `--diagram-danger`, NOT `--danger`. The latter is theme-aware (it remaps
    // to a pale `--_danger-dark` for dark and AMOLED), and this line sits on the
    // deliberately non-theme-aware `--diagram-surface`, so the theme token would
    // put pale salmon on near-white at roughly 2.5:1. That is the exact drift
    // #629 is about, one element over: the surface fixed and the ink moving.
    color: "var(--danger)",
  },

  // The bounded, interactive mermaid viewer (myne-md/myne#708). The frame is the
  // positioning context, the viewport clips, and the SVG carries the pan/zoom
  // transform. The pan/zoom cluster and the top-right chrome are NOT here: the
  // expanded viewer is appended to `document.body`, outside CodeMirror's theme
  // scope, so those rules live in `mermaid-viewer-styles.ts` and serve both
  // scopes. Values below are tokens because `check-token-adoption.mjs` ratchets
  // this file: a new numeric literal here would fail the commit.
  ".cm-mermaid-card-viewer": {
    display: "block",
    overflowX: "hidden",
  },
  ".cm-mermaid-frame": {
    position: "relative",
  },
  ".cm-mermaid-viewport": {
    position: "relative",
    overflow: "hidden",
    width: "100%",
    outline: "none",
    touchAction: "none",
    // Dragging to pan must never select the diagram's text labels.
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  ".cm-mermaid-viewport:focus-visible": {
    outline: "var(--focus-ring-width, 2px) solid var(--accent-1, currentColor)",
    outlineOffset: "var(--focus-ring-offset, 2px)",
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
    // TOP-align the number to the line's FIRST visual row (Obsidian parity, QA):
    // a wrapped/tall line keeps its number on the first row instead of floating
    // it to the vertical centre of the whole wrapped block. `paddingTop` seats it
    // on the text baseline of that first row (the value tracks the number's own
    // font so it scales with the editor text-size pref). Right-aligned toward the
    // content. This changes only vertical placement WITHIN the gutter element —
    // never the line height — so it can't destabilise the scroll height map.
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "flex-end",
    color: "var(--fg-3, #6b6a64)",
    opacity: "0.5",
    fontFamily: "var(--font-mono)",
    fontSize: "0.8em",
    // Right gap pairs the number with the adjacent fold arrow (the fold gutter
    // sits between the number and the text, Obsidian order — see line-numbers.ts).
    padding: "0.32em 10px 0 8px",
    minWidth: "1.6em",
  },

  // Fold gutter (heading-list-folding / MYND-300) — HOVER-REVEAL, Obsidian-style
  // minimal chrome on a prose-first editor. The gutter slot stays narrow + quiet;
  // the fold arrow appears only when the editor is hovered (the "can fold" ⌄),
  // EXCEPT a line that is currently folded keeps its › visible so the user can
  // always find + click to unfold. Tokens only (no hex).
  ".cm-foldGutter .cm-gutterElement": {
    // Top-align the fold arrow to the first row too, so it lines up with the
    // now-top-aligned line number instead of centring on a tall/wrapped line.
    padding: "0.28em 2px 0",
    minWidth: "1.1em",
    display: "flex",
    alignItems: "flex-start",
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
    fontWeight: "var(--weight-bold)",
  },
  // The icon is a flex ITEM, and WebKit does not honour an SVG's intrinsic size
  // as its content-based minimum — so once the inline-flex box is sized below its
  // max-content width (long title, narrow pane, wrapped line) the icon collapses
  // to zero width and the header renders as title-only. That is the desktop
  // WKWebView, and it varies with title length and pane width rather than with
  // anything the user did, which is what made it read as random (#376). Pin the
  // box: no shrink, explicit size, independent of intrinsic sizing.
  ".cm-callout-title svg": {
    flex: "none",
    width: "16px",
    height: "16px",
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
    // The quote's own inset, as a RULE rather than as part of the inline style
    // `blockquote.ts` writes. Two line decorations on one line concatenate their
    // `style` attributes, and two `padding-left` declarations do not compose, so
    // a quoted LIST item lost the list's hanging indent to whichever extension
    // was registered later. A stylesheet rule loses to an inline style, so the
    // list's own `padding-left` (which already folds `--cm-line-lead` in) wins
    // on a list line, and this applies on every other quoted line. See
    // `blockquoteBarStyle`.
    paddingLeft: "var(--cm-line-lead, 0px)",
  },
  // Definition lists — line classes from definition-list.ts (MYND-152). Term
  // reads as a label; definition rows indent under it with the `:` hidden.
  ".cm-def-term": {
    fontWeight: "var(--weight-bold)",
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
    fontWeight: "var(--weight-bold)",
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
    // top = column-handle gutter, left = row-handle gutter. The left gutter is
    // as narrow as the side-by-side row grip (−16px) + delete (−24px) controls
    // allow without clipping under `overflow-x: auto` (QA: was 34px, too indented).
    padding: "16px 0 0 26px",
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
    transition: "opacity var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard)",
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
    transition: "opacity var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard)",
  },
  ".cm-table-del::before": { content: '"\\00d7"' }, // ×
  ".cm-table-del:hover": { color: "var(--extended-color-red-600, #c0392b)" },
  ".cm-table-del-col": { top: "-16px", right: "0" },
  ".cm-table-del-row": { left: "-24px", top: "50%", transform: "translateY(-50%)" },
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
    transition: "opacity var(--duration-fast) var(--ease-standard), background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard)",
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
  // Solid accent fill + contrasting tick (Obsidian-style) rather than the old
  // washed-out accent-soft tint — a checked item reads boldly as "done".
  ".cm-task-checkbox-checked": {
    backgroundColor: "var(--accent, #2c4a7a)",
    borderColor: "var(--accent, #2c4a7a)",
  },
  // Checkmark drawn with borders (not a glyph, to avoid font-metric drift) and
  // centered with absolute positioning + transform — deterministic regardless
  // of the box's content-box quirks. translateY is biased up slightly so the
  // tick reads optically centered (its visual mass hangs low-left). The tick is
  // `--accent-on` (white) for contrast on the solid accent fill.
  ".cm-task-checkbox-checked::after": {
    content: '""',
    position: "absolute",
    top: "50%",
    left: "50%",
    width: "4px",
    height: "8px",
    boxSizing: "border-box",
    borderStyle: "solid",
    borderColor: "var(--accent-on, #ffffff)",
    borderWidth: "0 2px 2px 0",
    transform: "translate(-50%, -60%) rotate(45deg)",
  },
  // Completed-todo label: struck through + muted so it recedes from active items.
  ".cm-task-done-label": {
    textDecoration: "line-through",
    textDecorationColor: "var(--line-3, #a3a29c)",
    color: "var(--fg-3)",
  },
  // Carve-out (MYND-614 task 9) — MANDATORY, not cosmetic. The completed-task
  // strike runs to the end of the line, so without this it draws straight
  // through every chip on that line and the values become unreadable. The chip
  // keeps its own muted treatment; the strike belongs to the prose.
  ".cm-task-done-label .cm-task-chip": {
    textDecoration: "none",
  },
  // The same carve-out for a malformed field's hint underline: two overlapping
  // decorations on one span render as a muddle.
  ".cm-task-done-label .cm-task-field-invalid": {
    textDecoration: "underline dotted var(--fg-3, #6b6a64)",
  },

  // Wikilink chip widget from wikilink/chip-widget.ts.
  //
  // A link reads as TEXT, not as a box (myne-md/myne#601). It was a filled,
  // bordered pill in its own sans face at its own size: a foreign object in the
  // middle of a sentence, which is what "I cannot tell that I made a backlink"
  // meant: the shape said "widget", and only the shape said anything. Accent
  // colour on the note's own type says "this is a link to another note" with the
  // vocabulary every other document uses, and it leaves the line's rhythm alone.
  //
  // The box also cost two things the text form does not: an inline-block inherits
  // the list hanging indent's negative `text-indent` (hence the reset that used
  // to be needed here), and a padded, bordered box on one line makes CM6's height
  // map uneven, which is the scrolling jitter the vertical-margin comment below
  // was reverted for.
  ".cm-wikilink-chip": {
    color: "var(--accent, #2c4a7a)",
    // Underlined only under the pointer: an always-underlined run of links turns
    // a paragraph into a ladder, and the colour already carries the meaning.
    textDecoration: "none",
    cursor: "pointer",
    // Horizontal margin only. A VERTICAL margin makes any line holding a chip
    // taller than its neighbours, which gives CM6's height map variable line
    // heights and destabilises scrolling on long docs (jitter/jumping).
    margin: "0",
  },
  ".cm-wikilink-chip:hover": {
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  // An `![[embed]]` is a transclusion rather than a link, and italic is what
  // says so now that the base form carries no box to tint (myne-md/myne#601).
  ".cm-wikilink-chip-embed": {
    fontStyle: "italic",
  },
  // MYND-634: a drawing embed is visually its own thing, not a link to prose.
  // The full inline canvas (a locked thumbnail that unlocks into an editable
  // surface) renders through this same class once it lands; until then the chip
  // at least stops claiming to be a text note.
  ".cm-wikilink-chip-drawing": {
    fontStyle: "normal",
    borderStyle: "dashed",
    borderColor: "var(--line-2, #cfccc4)",
  },
  // MYND-634 — inline drawing embed (`![[Drawing]]`). ONE frame for both states:
  // a header (editable title + an Edit/Done button) over a same-height body — the
  // rendered thumbnail image, or the live canvas. Identical background / width /
  // height in both, so Edit⇄Done swaps only the button + body and never resizes
  // the widget or jumps the scroll (#213 review). Own line via `display: block`.
  ".cm-drawing-embed": {
    display: "block",
    position: "relative",
    margin: "8px 0",
    maxWidth: "100%",
    border: "1px solid var(--line-2, #cfccc4)",
    borderRadius: "var(--radius-2, 6px)",
    overflow: "hidden",
    background: "var(--paper)",
  },
  // Desktop view-only chrome (#213 review): title + Edit float over the top of the
  // drawing and appear only on hover, so a static drawing reads as the drawing.
  ".cm-drawing-embed-hover-chrome": {
    position: "absolute",
    top: "0",
    left: "0",
    right: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    padding: "6px 6px 6px 10px",
    background: "linear-gradient(to bottom, rgba(0,0,0,0.55), rgba(0,0,0,0))",
    opacity: "0",
    transition: "opacity var(--duration-fast, 120ms) var(--ease-standard, ease)",
    pointerEvents: "none",
  },
  ".cm-drawing-embed:hover .cm-drawing-embed-hover-chrome, .cm-drawing-embed:focus-within .cm-drawing-embed-hover-chrome": {
    opacity: "1",
    pointerEvents: "auto",
  },
  // In the hover chrome the title sits on the dark gradient — force a light ink
  // regardless of theme so it reads over the drawing.
  ".cm-drawing-embed-hover-chrome .cm-drawing-embed-title-static": {
    color: "#fff",
  },
  ".cm-drawing-embed-header": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    padding: "4px 6px 4px 8px",
    borderBottom: "1px solid var(--line-1, #d8d5cc)",
    background: "var(--paper-2, #f3f1eb)",
  },
  // The title is an editable field (rename rewrites the `![[Title]]` reference
  // too). `appearance: none` + explicit theme colours so it is never the white
  // native text-input box on a dark theme (#213 review).
  ".cm-drawing-embed-title-input": {
    flex: "1",
    minWidth: "0",
    appearance: "none",
    WebkitAppearance: "none",
    font: "inherit",
    fontSize: "13px",
    fontWeight: "var(--weight-semibold)",
    color: "var(--fg-1)",
    caretColor: "var(--fg-1)",
    fontFamily: "var(--font-sans)",
    backgroundColor: "transparent",
    border: "1px solid transparent",
    borderRadius: "var(--radius-1, 4px)",
    padding: "2px 6px",
  },
  ".cm-drawing-embed-title-input:hover": {
    backgroundColor: "var(--paper-3, #ece9e2)",
  },
  ".cm-drawing-embed-title-input:focus": {
    outline: "none",
    backgroundColor: "var(--paper-3, #ece9e2)",
    borderColor: "var(--accent, var(--line-2, #cfccc4))",
  },
  // Static title (a host without a ref-rewriting rename, e.g. mobile) — same look
  // as the editable field, but plain text.
  ".cm-drawing-embed-title-static": {
    flex: "1",
    minWidth: "0",
    fontSize: "13px",
    fontWeight: "var(--weight-semibold)",
    color: "var(--fg-1)",
    fontFamily: "var(--font-sans)",
    padding: "2px 6px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // The header action — Edit (thumbnail) / Done (editing). Same box in both.
  ".cm-drawing-embed-action": {
    font: "inherit",
    fontSize: "12px",
    fontWeight: "var(--weight-semibold)",
    padding: "3px 12px",
    borderRadius: "var(--radius-1, 4px)",
    border: "1px solid var(--line-2, #cfccc4)",
    background: "var(--paper)",
    color: "var(--fg-1)",
    cursor: "pointer",
    flexShrink: "0",
  },
  ".cm-drawing-embed-action:hover": {
    background: "var(--paper-3, #ece9e2)",
  },
  // Thumbnail body — SAME height as the canvas, so Edit⇄Done never resizes. Its
  // backdrop is set inline to the live Excalidraw canvas colour (theme-matched),
  // so the collapsed state uses the identical palette as the editor.
  ".cm-drawing-embed-body": {
    height: "420px",
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    cursor: "pointer",
  },
  ".cm-drawing-embed-body[data-empty]": {
    color: "var(--fg-3)",
  },
  ".cm-drawing-embed-empty-hint": {
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    color: "var(--fg-3)",
  },
  ".cm-drawing-embed-empty-hint::before": {
    content: "'✎  '",
  },
  ".cm-drawing-embed-img": {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain",
    display: "block",
  },
  // Excalidraw needs a concretely-sized parent; the inline canvas viewport.
  ".cm-drawing-embed-canvas": {
    position: "relative",
    height: "420px",
    width: "100%",
    overflow: "hidden",
  },
  ".cm-drawing-embed-label": {
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    color: "var(--fg-2)",
    padding: "8px",
  },
  // §5.3 broken-link styling (MYND-37/83): a wikilink whose target matches no
  // note. It carries no accent and a dotted underline, so it reads as a link
  // that does not lead anywhere rather than as one that does.
  //
  // The distinction is load-bearing, not decorative (myne-md/myne#601): clicking
  // a broken chip is DELIBERATELY inert (its target does not exist), so if the
  // two look alike, a link that was never going to work is indistinguishable
  // from one that is broken in the app. That is what "clicking a backlink does
  // not go to the note" looks like from the outside.
  ".cm-wikilink-chip-broken": {
    color: "var(--fg-3)",
    fontStyle: "italic",
    textDecoration: "underline dotted var(--fg-3)",
    textUnderlineOffset: "2px",
    cursor: "default",
  },
  ".cm-wikilink-chip-broken:hover": {
    textDecoration: "underline dotted var(--fg-3)",
  },
  // Inline #tag chip (tag-system #3 / MYND-45) — derived from the single TS-5
  // tag-pill token (`src/notes/tagPillToken.ts`) so the editor chip and the
  // browser's pill rows never drift. Pill shape distinguishes a tag from a
  // wikilink chip.
  ...tagChipCmTheme(),
  ...taskChipCmTheme(),
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
    fontWeight: "var(--weight-semibold)",
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
    // Anchors the embed's "⋯" overlay (.cm-attachment-embed-menu).
    position: "relative",
    // No frame: the image renders directly on the editor surface — no white
    // border / background / padding (dogfooding feedback). The `<img>` itself
    // keeps a subtle radius (.cm-attachment-img).
    // Vertical breathing room so two attachments rendered back-to-back are
    // visually separated. Token-based block spacing, `--space-3` rhythm.
    // Small top margin so the block widget's top lines up with the top-aligned
    // line number (a full --space-3 top margin floated the number above the
    // widget); the bottom keeps the --space-3 block rhythm.
    margin: "3px 0 var(--space-3, 10px)",
  },
  ".cm-attachment-img": {
    display: "block",
    maxWidth: "100%",
    height: "auto",
    borderRadius: "4px",
  },
  // Drag-to-resize handles (myne-md/myne#604), on the whole-line block form
  // only. Hidden until the frame is hovered or a drag is in flight, because a
  // permanent chrome on every image is the ambient decoration the design canon
  // keeps out of a writing surface. `--accent` while dragging is the accent
  // rule's "the one thing actually happening" arm, same as the save readout's.
  ".cm-attachment-resize": {
    position: "absolute",
    opacity: "0",
    background: "var(--fg-3)",
    borderRadius: "999px",
    transition: "opacity var(--duration-fast) var(--ease-standard)",
    // Above the image so the pointer lands on the handle rather than on the
    // lightbox click target underneath it.
    zIndex: "2",
  },
  ".cm-attachment-frame:hover .cm-attachment-resize, .cm-attachment-resizing .cm-attachment-resize":
    {
      opacity: "0.7",
    },
  ".cm-attachment-resizing .cm-attachment-resize": {
    background: "var(--accent)",
    opacity: "1",
  },
  // Right edge: a vertical bar centred on the image's own height, inset so it
  // reads as sitting ON the image rather than floating beside it.
  ".cm-attachment-resize-e": {
    top: "50%",
    right: "4px",
    width: "4px",
    height: "36px",
    transform: "translateY(-50%)",
    cursor: "ew-resize",
  },
  // Bottom-right corner: the square grip, which is where a pointer goes first.
  ".cm-attachment-resize-se": {
    right: "4px",
    bottom: "4px",
    width: "10px",
    height: "10px",
    borderRadius: "3px",
    cursor: "nwse-resize",
  },
  // While a drag is in flight nothing else on the page should be selecting text
  // or showing a zoom cursor: the gesture owns the pointer until release.
  ".cm-attachment-resizing": {
    userSelect: "none",
  },
  ".cm-attachment-resizing .cm-attachment-img": {
    cursor: "ew-resize",
  },
  // Embed alignment (myne#409). The default frame is `inline-flex`, which sits
  // in the line box and which no margin can centre. An ALIGNED frame becomes
  // block-level and `fit-content` wide so the auto margins have something to
  // distribute; an explicit `w=` overrides the width inline and the margins
  // still bite. Alignment is only ever applied as a class, never as an inline
  // style string built from a note-authored value.
  ".cm-attachment-frame-align": {
    display: "flex",
    width: "fit-content",
  },
  ".cm-attachment-frame-align-left": {
    marginLeft: "0",
    marginRight: "auto",
  },
  ".cm-attachment-frame-align-center": {
    marginLeft: "auto",
    marginRight: "auto",
  },
  ".cm-attachment-frame-align-right": {
    marginLeft: "auto",
    marginRight: "0",
  },
  // (Filename caption removed in the editor embed — dogfooding fix #2. The
  // media renders alone; the library keeps filenames, out of scope here.)
  // Inline scrollable multi-page reader: bounded box, the pages stack inside and
  // scroll. No white frame (consistent with the inline image rendering directly
  // on the surface). The scroller IS the IntersectionObserver root.
  ".cm-attachment-pdf-scroller": {
    display: "block",
    // 320px is the INTENDED width, not a floor: `width: 320px` alone overflowed
    // a phone (myne-md/myne#630), whose usable text column is around 338px
    // before this box's own siblings, and there is no viewport at which a reader
    // wider than its column is the right answer. `min()` keeps the intent and
    // lets it shrink; `box-sizing` keeps the border inside the budget.
    width: "min(320px, 100%)",
    maxWidth: "100%",
    boxSizing: "border-box",
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
    color: "var(--fg-3, #6b6a64)",
  },
  ".cm-attachment-pdf-fallback-label": {
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    letterSpacing: "0.06em",
    color: "var(--fg-3, #6b6a64)",
  },

  // Non-fetching `![](url)` / `![][ref]` chip — NEUTRAL family (per the design
  // pass: not accent). radius 6, padding 3/8, flex row gap 6, 1px inner stroke.
  ".cm-attachment-url-chip": {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "3px 8px",
    borderRadius: "6px",
    // Theme tokens (was hardcoded light hex, which rendered as a white pill on
    // dark/AMOLED themes) — same recessed-surface family as the file-card.
    backgroundColor: "var(--bg-2, #f4f4f2)",
    border: "1px solid var(--line-1, #e3e2dd)",
    color: "var(--fg-1, #1a1a17)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    fontWeight: "var(--weight-medium)",
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
    fontWeight: "var(--weight-medium)",
    verticalAlign: "baseline",
    cursor: "default",
  },
  ".cm-attachment-tombstone-deleted": {
    // Theme tokens (was hardcoded light hex) — recessed neutral surface.
    backgroundColor: "var(--bg-2, #f4f4f2)",
    border: "1px solid var(--line-1, #e3e2dd)",
    color: "var(--fg-3, #6b6a64)",
  },
  ".cm-attachment-tombstone-deleted .cm-attachment-tombstone-label": {
    textDecoration: "line-through",
    textDecorationColor: "var(--line-2, #c8c7c1)",
  },
  ".cm-attachment-tombstone-broken": {
    // Danger tint via the per-theme --danger-soft token (was color-mix over a
    // hardcoded light base, which both drops on older WKWebView AND reads light
    // on AMOLED). --danger-soft is dark on dark themes; the callout-danger convention.
    backgroundColor: "var(--danger-soft, #f5e7e5)",
    border: "1px solid var(--danger, #8a2a23)",
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
    // Small top margin so the block widget's top lines up with the top-aligned
    // line number (a full --space-3 top margin floated the number above the
    // widget); the bottom keeps the --space-3 block rhythm.
    margin: "3px 0 var(--space-3, 10px)",
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
    fontWeight: "var(--weight-medium)",
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
  // The two controls that overlay an inline embed's top-right corner: the "⋯"
  // menu and the unreadable-segment marker. One surface treatment for both, so
  // they read as a single control cluster rather than two unrelated badges, and
  // so a change to the surface cannot drift between them. Both need their own
  // paper + hairline + shadow because they sit over arbitrary image content and
  // would otherwise be illegible on half of it.
  ".cm-attachment-embed-menu, .cm-attachment-embed-warning": {
    position: "absolute",
    top: "var(--space-2, 8px)",
    zIndex: "1",
    backgroundColor: "var(--paper, #fbfbfa)",
    border: "1px solid var(--line-2, #c8c7c1)",
    borderRadius: "var(--radius-2, 6px)",
  },
  // Persistent unreadable-segment marker (myne#409, `markdown-dialect.md`
  // §3.9.3). Deliberately QUIET: the embed still renders correctly at its
  // default size, so a loud marker would read as damage rather than as "one
  // segment could not be read". Offset left of the "⋯" it sits beside, so
  // moving the menu means moving this with it.
  ".cm-attachment-embed-warning": {
    right: "calc(var(--space-2, 8px) + var(--space-6, 32px))",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "20px",
    height: "20px",
    color: "var(--warning, #8a6a1f)",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--weight-semibold)",
    cursor: "default",
  },
  // The "⋯" on an inline image / PDF EMBED. Unlike the file card, an embed has
  // no metadata row to host the button, so it overlays the media instead.
  //
  // Deliberately NOT hover-gated. `editor/` is shared with the mobile WebView,
  // where there is no hover and a reveal-on-hover control is unreachable.
  ".cm-attachment-embed-menu": {
    right: "var(--space-2, 8px)",
    lineHeight: "0",
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

  // Inline text/structured preview (MYND-268). The widget reuses the file-card
  // chrome for the HEADER, but a preview must STACK header-over-body — override
  // the file-card's inline-flex ROW (+ narrow 360px cap) to a full-width column.
  ".cm-attachment-text-preview": {
    display: "flex", // override the file-card's inline-flex → block flex column
    flexDirection: "column",
    alignItems: "stretch",
    gap: "0",
    padding: "0",
    width: "100%",
    maxWidth: "560px",
    overflow: "hidden", // keep the body scroll inside the rounded card
  },
  ".cm-attachment-text-preview-header": {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 10px",
    borderBottom: "1px solid var(--line-1, #e3e2dd)",
  },
  ".cm-attachment-text-preview-body": {
    padding: "8px 12px",
    fontSize: "12px",
    color: "var(--fg-1)",
  },
  ".cm-attachment-text-preview-pre": {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    lineHeight: "1.5",
    whiteSpace: "pre",
    margin: "0",
    color: "var(--fg-1)",
  },
  // csv/tsv/xlsx grid — bordered, padded cells that don't wrap ("name" must not
  // become "na⏎me"); the body's horizontal scroll handles a wide grid.
  ".cm-attachment-text-preview-table": {
    borderCollapse: "collapse",
    width: "auto",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    color: "var(--fg-1)",
  },
  ".cm-attachment-text-preview-table td": {
    border: "1px solid var(--line-1, #e3e2dd)",
    padding: "4px 8px",
    textAlign: "left",
    verticalAlign: "top",
    whiteSpace: "nowrap",
  },
  ".cm-attachment-text-preview-table tr:first-child td": {
    fontWeight: "var(--weight-semibold)",
    backgroundColor: "var(--bg-2, #f4f4f2)",
  },
  // docx structured render — tame the browser-default huge headings.
  ".cm-attachment-text-preview-doc": {
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    lineHeight: "1.5",
    color: "var(--fg-1)",
  },
  ".cm-attachment-text-preview-doc h1": { fontSize: "1.35em", fontWeight: "var(--weight-bold)", margin: "0.4em 0 0.2em" },
  ".cm-attachment-text-preview-doc h2": { fontSize: "1.2em", fontWeight: "var(--weight-bold)", margin: "0.4em 0 0.2em" },
  ".cm-attachment-text-preview-doc h3": { fontSize: "1.1em", fontWeight: "var(--weight-semibold)", margin: "0.4em 0 0.2em" },
  ".cm-attachment-text-preview-doc h4, .cm-attachment-text-preview-doc h5, .cm-attachment-text-preview-doc h6":
    { fontSize: "1em", fontWeight: "var(--weight-semibold)", margin: "0.3em 0 0.2em" },
  ".cm-attachment-text-preview-doc p": { margin: "0.3em 0" },
  ".cm-attachment-text-preview-truncated": {
    display: "block",
    marginTop: "6px",
    fontSize: "11px",
    fontStyle: "italic",
    color: "var(--fg-3)",
  },

  // Inline audio player (voice notes, MYND-259) — a sibling of the file-card,
  // same surface tokens. Circular accent play button, a seek track (the
  // waveform overlays this track in a later slice), and a mono time readout.
  ".cm-attachment-audio": {
    display: "inline-flex",
    flexDirection: "column",
    gap: "6px",
    // Same shape as the PDF scroller above (myne-md/myne#630): 360px is the
    // intended width, and a phone's text column is narrower than that, so the
    // player has to be allowed to shrink instead of widening `.cm-content` and
    // making the whole note scroll sideways.
    width: "min(360px, 100%)",
    maxWidth: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    backgroundColor: "var(--bg-2, #f4f4f2)",
    border: "1px solid var(--line-1, #e3e2dd)",
    borderRadius: "var(--radius-2, 6px)",
    verticalAlign: "top",
    // Small top margin so the block widget's top lines up with the top-aligned
    // line number (a full --space-3 top margin floated the number above the
    // widget); the bottom keeps the --space-3 block rhythm.
    margin: "3px 0 var(--space-3, 10px)",
    fontFamily: "var(--font-sans)",
    cursor: "default",
  },
  // Filename — top-left of the card.
  ".cm-attachment-audio-name": {
    fontSize: "12px",
    fontWeight: "var(--weight-medium)",
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

  // --- transcript section (voice-to-text MYND-552) --------------------------
  ".cm-attachment-audio-transcript-section": {
    display: "block",
  },
  // In-flight progress affordance (busy chrome + live partial + Stop).
  ".cm-attachment-audio-transcript-progress": {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "8px",
    marginTop: "2px",
    padding: "6px 8px",
    borderRadius: "var(--radius-1, 4px)",
    backgroundColor: "var(--paper-2, #f3f1eb)",
  },
  ".cm-attachment-audio-transcript-progress-label": {
    fontSize: "12px",
    color: "var(--fg-2, #44423d)",
  },
  ".cm-attachment-audio-transcript-meter": {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    height: "14px",
  },
  // Bar height/opacity is animated by the global keyframes in
  // `attachments/styles.ts` (@keyframes is unsupported in the CM theme's
  // StyleModule) — this rule only supplies the static box + accent colour.
  ".cm-attachment-audio-transcript-bar": {
    width: "3px",
    height: "40%",
    borderRadius: "999px",
    backgroundColor: "var(--accent, #2c4a7a)",
  },
  ".cm-attachment-audio-transcript-preview": {
    flex: "1 1 100%",
    fontSize: "12px",
    color: "var(--fg-3, #6b6a64)",
    fontStyle: "italic",
    maxHeight: "3.6em",
    overflow: "hidden",
  },
  ".cm-attachment-audio-transcript-stop": {
    appearance: "none",
    border: "1px solid var(--line-2, #c8c7c1)",
    background: "transparent",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    padding: "3px 10px",
    borderRadius: "var(--radius-1, 4px)",
    cursor: "pointer",
    color: "var(--fg-1, #1a1a17)",
  },
  // Completed read-only expander.
  ".cm-attachment-audio-transcript": {
    display: "block",
    marginTop: "4px",
  },
  ".cm-attachment-audio-transcript-toggle": {
    appearance: "none",
    border: "none",
    background: "transparent",
    padding: "2px 0",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    fontWeight: "var(--weight-semibold)",
    color: "var(--fg-2, #44423d)",
    cursor: "pointer",
  },
  ".cm-attachment-audio-transcript-bodywrap": {
    display: "block",
  },
  ".cm-attachment-audio-transcript-body": {
    display: "block",
    marginTop: "2px",
    padding: "6px 8px",
    borderRadius: "var(--radius-1, 4px)",
    backgroundColor: "var(--paper-2, #f3f1eb)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    lineHeight: "1.5",
    color: "var(--fg-1, #1a1a17)",
    whiteSpace: "pre-wrap",
    maxHeight: "200px",
    overflow: "auto",
  },
  ".cm-attachment-audio-transcript-note": {
    display: "block",
    marginTop: "4px",
    fontSize: "11px",
    color: "var(--fg-3, #6b6a64)",
    lineHeight: "1.4",
  },
  ".cm-attachment-audio-transcript-insert": {
    appearance: "none",
    marginTop: "6px",
    border: "1px solid var(--line-2, #c8c7c1)",
    background: "var(--paper, #faf8f3)",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    padding: "4px 10px",
    borderRadius: "var(--radius-1, 4px)",
    cursor: "pointer",
    color: "var(--fg-1, #1a1a17)",
  },
  ".cm-attachment-audio-transcript-hint": {
    display: "block",
    marginTop: "4px",
    fontSize: "12px",
    color: "var(--fg-3, #6b6a64)",
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
    fontWeight: "var(--weight-bold)",
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
