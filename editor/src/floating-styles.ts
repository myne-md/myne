// Global CSS injection for the editor's floating UI surfaces (slash menu,
// selection toolbar, inline URL overlay).
//
// These elements are mounted to `document.body` so `position: fixed`
// escapes any ancestor containing-block context (transform/filter/contain
// quirks). CodeMirror 6's `EditorView.theme(...)` rules are scoped to the
// editor's theme class, so descendant selectors don't match when the
// element is outside `.cm-editor`. Hence: global CSS via a `<style>` tag
// appended to `document.head` once on first import.
//
// All values use `var(--*)` tokens from `docs/design/colors_and_type.css`
// with hex fallbacks. Live tokens always win — fallbacks only kick in if
// the CSS variable layer fails to load.

const STYLE_ID = "myne-editor-floating-styles";

const CSS = `
.cm-slash-menu {
  background-color: var(--paper, #faf8f3);
  border: 1px solid var(--line-2, #c8c7c1);
  border-radius: var(--radius-3, 8px);
  box-shadow: var(--shadow-3, 0 8px 24px rgba(0,0,0,0.12));
  padding: 6px;
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  color: var(--fg-1);
  max-height: 288px;
  overflow-y: auto;
}
.cm-slash-menu-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 8px;
  border-radius: var(--radius-1, 3px);
  cursor: pointer;
}
/* The keyboard's position in the list, and it has to be legible in EVERY theme
   (myne-md/myne#601). This was one step up the surface ramp from the menu's own
   background: a clear step in the light theme, and on AMOLED the difference
   between #000000 and #0c0c0b, which is invisible on a screen. Arrowing through
   the list then moved a highlight nobody could see, so the picker read as
   mouse-only. The accent tint carries it on its own; a leading accent bar was
   tried alongside and read as a notch cut out of the row. */
.cm-slash-menu-row-selected {
  background-color: var(--accent-soft, #e8edf5);
}
.cm-slash-menu-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 20px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: var(--weight-semibold);
  color: var(--fg-2);
  flex-shrink: 0;
}
.cm-slash-menu-label {
  flex: 1;
}
.cm-slash-menu-kbd {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-3);
}

/* Spell correction menu (MYND-265) — mirrors the slash menu chrome. */
.cm-spell-menu {
  position: fixed;
  z-index: 30;
  background-color: var(--paper, #faf8f3);
  border: 1px solid var(--line-2, #c8c7c1);
  border-radius: var(--radius-3, 8px);
  box-shadow: var(--shadow-3, 0 8px 24px rgba(0,0,0,0.12));
  padding: 6px;
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  color: var(--fg-1);
  min-width: 180px;
  max-height: 288px;
  overflow-y: auto;
}
.cm-spell-menu-row {
  padding: 6px 8px;
  border-radius: var(--radius-1, 3px);
  cursor: pointer;
}
.cm-spell-menu-row:hover,
.cm-spell-menu-row-active {
  background-color: var(--paper-2, #f3f1eb);
}
.cm-spell-menu-empty {
  color: var(--fg-3);
  cursor: default;
}

/* [[ note picker (MYND-38) — two-line rows: title over vault path. Reuses the
   slash-menu surface + selected-row highlight; only the row becomes a column. */
.cm-wiki-picker-row {
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
}
.cm-wiki-picker-title {
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--fg-1);
  line-height: 1.3;
}
.cm-wiki-picker-path {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-3);
  line-height: 1.2;
}
/* Folder-target row (MYND-370): single line, glyph + path. Overrides the
   note row's column stack with a glyph-then-label horizontal layout. */
.cm-wiki-picker-folder-row {
  flex-direction: row;
  align-items: center;
  gap: var(--space-2);
}
.cm-wiki-picker-folder-glyph {
  width: 16px;
  color: var(--fg-3);
}
/* [[# current-note heading row (MYND-305): a # glyph (its repeat hints the
   level) + the heading text on one line — the current note IS the context, so no
   secondary path line, matching the folder row's single-line glyph layout. */
.cm-wiki-picker-heading-row {
  flex-direction: row;
  align-items: center;
  gap: var(--space-2);
}
.cm-wiki-picker-heading-glyph {
  min-width: 16px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--accent, var(--fg-3));
  text-align: left;
}
/* [[## vault-wide heading row (MYND-305): heading text over a smaller note-
   context line (the owning note's title) — the title-over-path stack of a note
   row, so the two pick surfaces read consistently and the vault scope is legible
   at a glance vs the single-line current-note rows. */
.cm-wiki-picker-vault-heading-row {
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
}

.cm-toolbar {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background-color: var(--paper, #faf8f3);
  border: 1px solid var(--line-2, #c8c7c1);
  border-radius: var(--radius-2, 6px);
  box-shadow: var(--shadow-2, 0 4px 12px rgba(0,0,0,0.08));
  padding: var(--space-1);
  font-family: var(--font-sans);
}
.cm-toolbar-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  background-color: transparent;
  color: var(--fg-1);
  font-size: var(--text-sm);
  cursor: pointer;
  border-radius: var(--radius-1, 3px);
  font-family: var(--font-sans);
}
.cm-toolbar-button:hover {
  background-color: var(--paper-2, #f3f1eb);
}
/* The leading block-type control carries a word label ("Paragraph" / "H2"), so
   it overrides the fixed 28px square button width — auto width, no wrap, a
   little horizontal padding, and a divider separating it from the format
   buttons (Obsidian-style). */
.cm-toolbar-blocktype {
  width: auto;
  min-width: 0;
  padding: 0 8px;
  gap: 3px;
  white-space: nowrap;
  margin-right: 4px;
  border-right: 1px solid var(--line-1, #e3e2dd);
  border-radius: var(--radius-1, 3px) 0 0 var(--radius-1, 3px);
}
.cm-toolbar-heading-wrap {
  position: relative;
}
.cm-toolbar-heading-dropdown {
  background-color: var(--paper, #faf8f3);
  border: 1px solid var(--line-2, #c8c7c1);
  border-radius: var(--radius-2, 6px);
  box-shadow: var(--shadow-2, 0 4px 12px rgba(0,0,0,0.08));
  padding: var(--space-1);
  min-width: 120px;
}
.cm-toolbar-heading-item {
  padding: 6px 10px;
  font-size: var(--text-sm);
  cursor: pointer;
  border-radius: var(--radius-1, 3px);
  color: var(--fg-1);
}
.cm-toolbar-heading-item:hover {
  background-color: var(--paper-2, #f3f1eb);
}

/* Highlight color control (decisions.md 2026-06-15): "H" swatch + caret that
   opens a row of 5 color squares. Reuses the heading-dropdown chrome. */
.cm-toolbar-highlight-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.cm-toolbar-highlight-caret {
  width: 16px;
  font-size: 10px;
  color: var(--fg-3, #6b6a64);
}
.cm-toolbar-highlight-dropdown {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  max-width: 176px;
  background-color: var(--paper, #faf8f3);
  border: 1px solid var(--line-2, #c8c7c1);
  border-radius: var(--radius-2, 6px);
  box-shadow: var(--shadow-2, 0 4px 12px rgba(0,0,0,0.08));
  padding: 6px;
}
/* MYND-637: the Remove-highlight action, shown only while editing an existing
   highlight. Spans the swatch grid's full width on its own row. */
.cm-toolbar-highlight-remove {
  flex-basis: 100%;
  margin-top: var(--space-1);
  padding: var(--space-1) 6px;
  font-size: 12px;
  text-align: left;
  color: var(--fg-2, #4a4944);
  background: transparent;
  border: none;
  border-top: 1px solid var(--line-1, #e3e2dd);
  border-radius: 0;
  cursor: pointer;
}
.cm-toolbar-highlight-remove:hover {
  color: var(--fg-1, #23221e);
}
.cm-toolbar-highlight-swatch {
  width: 20px;
  height: 20px;
  border: 1px solid var(--line-1, #e3e2dd);
  border-radius: var(--radius-1, 3px);
  cursor: pointer;
  padding: 0;
}
.cm-toolbar-highlight-swatch:hover {
  border-color: var(--line-3, #a3a29c);
}

.cm-url-overlay {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  background-color: var(--paper, #faf8f3);
  border: 1px solid var(--line-2, #c8c7c1);
  border-radius: var(--radius-2, 6px);
  box-shadow: var(--shadow-2, 0 4px 12px rgba(0,0,0,0.08));
  padding: 6px 8px;
  font-family: var(--font-sans);
}
.cm-url-overlay-input {
  flex: 1;
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  background: transparent;
  outline: none;
  box-shadow: none;
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  color: var(--fg-1);
  min-width: 200px;
}
.cm-url-overlay-apply {
  border: 0;
  background-color: var(--accent, #2c4a7a);
  color: var(--accent-on, #fff);
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: var(--weight-semibold);
  padding: 6px 12px;
  border-radius: var(--radius-1, 3px);
  cursor: pointer;
}

.cm-cover-banner {
  /* Fixed height, never an aspect ratio: a split pane changes width a lot and a
     ratio would move where the body text starts (myne-md/myne#410). The height
     is reserved even while the catalog loads, so the text does not jump down
     when the image arrives. */
  position: relative;
  height: var(--cover-banner-h, 180px);
  margin: 0 0 var(--space-4, 16px);
  border-radius: var(--radius-2, 6px);
  overflow: hidden;
  background: var(--paper-2, #f4f2ec);
  /* Decorative: nothing here is text the user selects, and a drag across the
     banner should not paint a selection bar over it. Pointer events are NOT
     disabled, so the hover controls inside receive their own clicks. */
  user-select: none;
  -webkit-user-select: none;
}
.cm-cover-banner-controls {
  position: absolute;
  top: var(--space-2, 8px);
  right: var(--space-2, 8px);
  display: flex;
  gap: var(--space-1, 4px);
  /* Revealed on hover, and on focus-within so a control that DOES receive
     focus is visible while it has it. That is a safety net, not a keyboard
     route: these buttons sit inside CodeMirror content where Tab indents, so
     Tab never lands here. The keyboard route is the command palette. */
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-standard);
}
.cm-cover-banner:hover .cm-cover-banner-controls,
.cm-cover-banner:focus-within .cm-cover-banner-controls {
  opacity: 1;
}
.cm-cover-banner-control {
  font-family: var(--font-sans);
  font-size: 12px;
  line-height: 1;
  padding: var(--space-2, 8px) var(--space-3, 12px);
  border: 1px solid var(--line-1, #e3ded2);
  border-radius: var(--radius-1, 3px);
  background: var(--paper, #fbfaf7);
  color: var(--ink-1, #1a1917);
  cursor: pointer;
}
.cm-cover-banner-control:hover {
  background: var(--paper-2, #f4f2ec);
}

.cm-cover-banner-img {
  display: block;
  width: 100%;
  height: 100%;
  /* Centre crop. There is no per-note focal point by design; repositioning
     would need a second stored value. */
  object-fit: cover;
  object-position: center;
}

.cm-fm-properties-name-row {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
}
/* Only the reveal is here: the ghost-button look is shared with
   "+ Add property" further down, in one rule listing both classes.
   (No backticks anywhere in this file: the CSS is one template literal, and a
   stray backtick in a comment terminates it.) */
.cm-fm-add-cover {
  flex: 0 0 auto;
  /* Quiet until wanted: a note without a cover should not carry a permanent
     advertisement for one. */
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-standard);
}
.cm-fm-properties-name-row:hover .cm-fm-add-cover,
.cm-fm-add-cover:focus-visible {
  opacity: 1;
}

/* Touch: the banner controls hide until tapped (myne-md/myne#715). Always
   visible was the first posture and it kept two buttons over every cover;
   the frame toggles a revealed class on tap (see cover-banner.ts), which
   reads like :hover below. The Properties "Add cover" row stays always
   visible: there is nothing to tap on a note without a cover.

   POSITION IS LOAD-BEARING: this must come after BOTH opacity-0 base rules.
   A media query adds no specificity, so with identical selectors source order
   decides, and an earlier block is silently overridden by the later base rule.
   That is exactly what happened when the two per-control blocks were merged
   into one and the merged block landed above the add-cover base rule. */
@media (pointer: coarse) {
  .cm-cover-banner.cm-cover-revealed .cm-cover-banner-controls {
    opacity: 1;
  }
  .cm-fm-add-cover {
    opacity: 1;
  }
}

.cm-fm-properties {
  padding: 2px 0 16px;
  /* Contain the whole Properties block (myne-md/myne#630). This is a
     block: true replace widget inside .cm-content, and .cm-content is a
     flex item of .cm-scroller with the default min-width: auto, so anything
     in here that refuses to shrink floors the editor's whole content width
     and turns CodeMirror's own overflow-x: auto into a sideways swipe over
     the entire note. The grid below plus its inputs were doing exactly that.

     container-type: inline-size, NOT contain: inline-size beside it. The
     container-type keyword applies inline-size containment by definition, so
     the pair is one declaration doing one job twice; and it buys the narrow
     layout further down a query container, so that layout responds to the PANE
     rather than the window. A split view on a wide monitor is exactly as narrow
     as a phone and has exactly the same problem.

     The containment idiom is .cm-table-editable's in theme.ts, minus its
     overflow-x: auto. A table has to scroll because its cells are nowrap by
     design, whereas this block reflows and has nothing to scroll to. */
  max-width: 100%;
  box-sizing: border-box;
  container-type: inline-size;
  font-family: var(--font-sans);
  /* Base for the widget's own text: the editor-typography preset (Settings →
     Editor → text size), matching the body text. Every child's font-size below
     is em-relative to this base — mirroring the heading em scale in theme.ts —
     so the Properties block scales with the text-size setting. The fallback is
     the canonical md default (14px). */
  font-size: var(--editor-text-size, 14px);
  /* MYND-608 defence-in-depth: atomicRanges stops the EDITOR cursor/selection
     from entering the hidden frontmatter source; this stops a raw pointer
     DRAG-selection from painting a text-selection bar across the widget. Text
     selection is re-enabled on the widget's own inputs just below so the fields
     stay usable. */
  user-select: none;
  -webkit-user-select: none;
}
.cm-fm-properties input,
.cm-fm-properties textarea,
/* The read-only managed rows are spans, not inputs, so the re-enable has to
   name them or a folder path or an updated: stamp cannot be selected or copied.
   They are the only representation of those bytes in the interface, so losing
   selection there would be a real loss beside the intended edit removal
   (myne-md/myne#872). */
.cm-fm-properties-key-static,
.cm-fm-properties-value-static {
  user-select: text;
  -webkit-user-select: text;
}
.cm-fm-properties-name {
  display: block;
  width: 100%;
  /* A flex item floors at its min-content width unless told otherwise, and an
     input's min-content width is its intrinsic default size (roughly 20
     characters) no matter what width it is given. This input is the flex item
     of .cm-fm-properties-name-row above, so without this the title row alone can
     be wider than a phone (myne-md/myne#630). */
  min-width: 0;
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  background: transparent;
  outline: 0;
  outline-style: none;
  box-shadow: none;
  font-family: var(--font-sans);
  font-size: 1.571em;
  font-weight: var(--weight-semibold);
  line-height: 1.3;
  color: var(--fg-1);
  padding: 2px 6px;
  margin: 0 -6px 10px;
  border-radius: var(--radius-1, 3px);
}
.cm-fm-properties-name::placeholder {
  color: var(--fg-3);
  font-style: italic;
  font-weight: var(--weight-regular);
}
.cm-fm-properties-name:hover {
  background: var(--paper-2, #f3f1eb);
}
.cm-fm-properties-name:focus,
.cm-fm-properties-name:focus-visible {
  outline: 0 !important;
  outline-style: none !important;
  box-shadow: none !important;
  background: var(--paper-2, #f3f1eb);
}
.cm-fm-properties-title {
  font-size: 1em;
  font-weight: var(--weight-semibold);
  color: var(--fg-1);
  margin-bottom: 10px;
}
.cm-fm-properties-list {
  display: grid;
  /* minmax(0, …) on both flexible tracks, not the bare 160px / 1fr this used to
     be. A grid track's automatic minimum is min-content, so the value column
     floored at its input's intrinsic width and the whole grid at roughly 370px
     (wider than a phone's usable text column, myne-md/myne#630). */
  grid-template-columns: 24px minmax(0, 160px) minmax(0, 1fr);
  row-gap: 2px;
  column-gap: var(--space-2);
  align-items: center;
}
.cm-fm-properties-row {
  display: contents;
}
.cm-fm-properties-icon {
  display: inline-flex;
  width: 20px;
  height: 24px;
  align-items: center;
  justify-content: center;
  color: var(--fg-3);
  font-size: 0.929em;
}
/* The type glyphs are a different SHAPE from the old uniform triple-bar, so
   they need their own optical sizing rather than inheriting one tuned for it.
   The date and checkbox marks in particular sit low and read small at the key
   font size (myne-md/myne#777). */
.cm-fm-properties-icon[data-property-type="date"],
.cm-fm-properties-icon[data-property-type="checkbox"] {
  font-size: 1.05em;
}
.cm-fm-properties-icon[data-property-type="number"] {
  font-family: var(--font-mono);
  font-size: 0.82em;
}

/* A date or number input is a NATIVE control, and the browser draws its own
   chrome inside: a calendar button, a spinner. They inherit the row's
   transparent background and hover, but their indicator is a foreground colour
   the theme has to supply or it stays the UA default black on a dark panel. */
.cm-fm-properties-value[data-property-type="date"],
.cm-fm-properties-value[data-property-type="number"] {
  color-scheme: light dark;
}
.cm-fm-properties-value[data-property-type="number"] {
  font-variant-numeric: tabular-nums;
}

/* A Myne-managed field the app owns: the same geometry as the inputs beside it
   so the grid does not jog, without the hover and focus affordances that
   promise an edit. The cursor stays default rather than text, since there is no
   caret to place. (myne-md/myne#872) */
.cm-fm-properties-key-static,
.cm-fm-properties-value-static {
  font-size: 0.929em;
  font-family: var(--font-sans);
  padding: var(--space-1) 6px;
  border-radius: var(--radius-1, 3px);
  cursor: default;
}
.cm-fm-properties-key-static {
  /* A managed key reads as a label rather than as a value: the same muted
     step the icon column uses. */
  color: var(--fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cm-fm-properties-value-static {
  /* The value keeps the editable rows' ink: the state is app state, but it is
     still what the user came to read. */
  color: var(--fg-1);
  min-width: 0;
  overflow-wrap: anywhere;
}

/* The checkbox row: a real control rather than the word true in a text box. */
.cm-fm-properties-checkbox {
  justify-self: start;
  margin: 0 6px;
  accent-color: var(--accent);
  cursor: pointer;
}

.cm-fm-properties-key {
  width: 100%;
  min-width: 0;
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  background: transparent;
  outline: 0;
  outline-style: none;
  box-shadow: none;
  font-size: 0.929em;
  color: var(--fg-2);
  font-family: var(--font-sans);
  padding: var(--space-1) 6px;
  border-radius: var(--radius-1, 3px);
}
.cm-fm-properties-key:hover {
  background: var(--paper-2, #f3f1eb);
}
.cm-fm-properties-key:focus,
.cm-fm-properties-key:focus-visible {
  outline: 0 !important;
  outline-style: none !important;
  box-shadow: none !important;
  background: var(--paper-2, #f3f1eb);
  color: var(--fg-1);
}
.cm-fm-properties-value {
  width: 100%;
  min-width: 0;
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  background: transparent;
  outline: 0;
  outline-style: none;
  box-shadow: none;
  font-family: var(--font-sans);
  font-size: 0.929em;
  color: var(--fg-1);
  padding: var(--space-1) 6px;
  border-radius: var(--radius-1, 3px);
}
.cm-fm-properties-value:hover {
  background: var(--paper-2, #f3f1eb);
}
.cm-fm-properties-value:focus,
.cm-fm-properties-value:focus-visible {
  /* WebKit applies a default focus ring on inputs that outline:none
   * alone does not always clear (especially under Tauris WKWebView).
   * Belt-and-suspenders reset, plus a subtle background-only focus
   * indicator matching Obsidians restrained styling. */
  outline: 0 !important;
  outline-style: none !important;
  box-shadow: none !important;
  background: var(--paper-2, #f3f1eb);
}
/* The Properties widget's ghost buttons: "+ Add property" and "Add cover".
   ONE rule, two identity classes rather than a shared class, because
   .cm-fm-properties-add is how existing tests find the add-property button and
   a shared class would make that selector ambiguous. The em-relative font-size
   is load-bearing: .cm-fm-properties sets an em base so the whole block follows
   Settings > Editor > text size, and a px size here would opt one control out. */
.cm-fm-properties-add,
.cm-fm-add-cover {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--fg-3);
  font-family: var(--font-sans);
  font-size: 0.929em;
  cursor: pointer;
  padding: var(--space-1) 6px;
  border-radius: var(--radius-1, 3px);
}
.cm-fm-properties-add {
  margin-top: 10px;
  margin-left: var(--space-5);
}
.cm-fm-properties-add:hover,
.cm-fm-add-cover:hover {
  background: var(--paper-2, #f3f1eb);
  color: var(--fg-1);
}
/* Sequence-valued key (e.g. the tags field): the value cell is one wrapping flex
   row of removable chips plus a trailing add-item field. Chip look mirrors the
   shared tag-pill token (tagPillToken.ts) so a frontmatter tag reads like the
   inline hashtag chip and the tag-browser pill. */
.cm-fm-properties-tags {
  display: flex;
  flex-wrap: wrap;
  min-width: 0;
  align-items: center;
  gap: var(--space-1);
  padding: 2px 6px;
}
.cm-fm-properties-tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  /* A chip is nowrap by design, so without this it is an unshrinkable flex item
     and a long tag name floors the whole Properties block's width
     (myne-md/myne#630). The label below already carries overflow: hidden and an
     ellipsis; a flex item's default min-width: auto is what was stopping that
     ellipsis from ever engaging. (No backticks anywhere in this file: the CSS is
     one template literal, and a stray backtick in a comment terminates it.) */
  min-width: 0;
  padding: 2px 4px 2px 8px;
  background: var(--paper-2, #f3f1eb);
  border: 1px solid var(--line-1, #e3e2dd);
  border-radius: var(--radius-pill, 999px);
  color: var(--fg-1);
  font-size: 0.857em;
  font-weight: var(--weight-medium);
  line-height: 1.4;
  white-space: nowrap;
}
.cm-fm-properties-tag-label {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 22ch;
}
.cm-fm-properties-tag-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  background: transparent;
  color: var(--fg-3);
  font-family: var(--font-sans);
  font-size: 1.1em;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  border-radius: var(--radius-1, 3px);
}
.cm-fm-properties-tag-remove:hover {
  color: var(--danger, #8a2a23);
}
.cm-fm-properties-tag-remove:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.cm-fm-properties-tag-input {
  flex: 1 1 6ch;
  min-width: 6ch;
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  background: transparent;
  outline: 0;
  outline-style: none;
  box-shadow: none;
  font-family: var(--font-sans);
  font-size: 0.929em;
  color: var(--fg-1);
  padding: var(--space-1) 6px;
  border-radius: var(--radius-1, 3px);
}
.cm-fm-properties-tag-input::placeholder {
  color: var(--fg-3);
}
.cm-fm-properties-tag-input:hover,
.cm-fm-properties-tag-input:focus,
.cm-fm-properties-tag-input:focus-visible {
  outline: 0 !important;
  outline-style: none !important;
  box-shadow: none !important;
  background: var(--paper-2, #f3f1eb);
}

/* Narrow Properties layout (myne-md/myne#630): a phone, or a split pane on a
   wide monitor, which is the same width and the same problem. The three-column
   grid keeps shrinking correctly now, but past a point a 160px key column beside
   a value column leaves neither readable, so the pair stacks: the icon keeps its
   own column and the key and the value each take the rest of the row.

   POSITION IS LOAD-BEARING, same rule as the pointer: coarse block far above.
   A container query adds no specificity, so with identical selectors source
   order decides, and this must come after every base rule it overrides. */
@container (max-width: 420px) {
  .cm-fm-properties-list {
    grid-template-columns: 24px minmax(0, 1fr);
    row-gap: var(--space-1, 4px);
  }
  /* The row is display: contents, so its three cells are grid items directly.
     The key spans nothing new; the value moves under it, skipping the icon
     column so it lines up with the key rather than with the icon. */
  .cm-fm-properties-key,
  .cm-fm-properties-key-static {
    grid-column: 2;
  }
  /* The read-only spans are cells of the same grid and must move with the
     inputs they stand in for; without them a managed row auto-places into the
     24px icon column and the panel scrambles at phone width, on nearly every
     note, because updated: is a read-only row (myne-md/myne#872). */
  .cm-fm-properties-value,
  .cm-fm-properties-value-static,
  .cm-fm-properties-tags {
    grid-column: 2;
  }
}

/* In-note find bar (MYND-175). Docked CM panel chrome, NOT a floating popover:
   it reflows the editor so it never occludes the current match, so it carries a
   bottom hairline and NO shadow (DESIGN.md: nothing on the editor surface gets a
   shadow — the deliberate difference from the floating slash-menu/toolbar above). */
.cm-find-bar {
  /* MYND-302: a column of rows (find row + optional replace row). The flex
     chrome the single-row bar carried now lives on .cm-find-bar-row. */
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  box-sizing: border-box;
  padding: var(--space-2) 12px;
  background-color: var(--paper, #fbfbfa);
  border-bottom: 1px solid var(--line-1, #e3e2dd);
  font-family: var(--font-sans);
}
.cm-find-bar-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
}
/* The date-fallback notice (myne-md/myne#609): a quiet line of prose, not a row
   of controls, so it overrides the flex row it inherits from. Muted like the
   "No matches" status rather than coloured as a warning, because nothing went wrong,
   the bar is saying which text produced the matches. It sits between the find
   row and the replace row, which puts it directly above the Replace buttons it
   explains being disabled. */
.cm-find-bar-fallback-row {
  display: block;
  color: var(--fg-3, #6b6a64);
  font-size: var(--text-sm);
  line-height: 1.4;
  padding-left: 2px;
}
/* The replace row's leading glyph sits in the same lead column as the find
   row's search icon (the toggle is the first element on the find row; the
   replace row reuses the lead-icon slot so the two inputs align). */
.cm-find-bar-toggle {
  color: var(--fg-3, #6b6a64);
  transition: transform var(--duration-fast, 120ms) var(--ease-standard, ease);
}
/* Expanded: the disclosure chevron rotates from ▶ to ▼. */
.cm-find-bar-toggle[aria-expanded="true"] svg {
  transform: rotate(90deg);
}
.cm-find-bar-replace-lead {
  color: var(--fg-3, #6b6a64);
}
/* Replace action buttons ("Replace" / "Replace all (N)") — text pills matching
   the inline-URL apply button's restraint, but secondary (not accent-filled):
   the bulk action is undoable, so it doesn't need an attention-grabbing fill. */
.cm-find-bar-action {
  flex-shrink: 0;
  height: 28px;
  box-sizing: border-box;
  border: 1px solid var(--line-2, #c8c7c1);
  background-color: var(--paper, #fbfbfa);
  color: var(--fg-2, #3a3934);
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: var(--weight-medium);
  padding: 0 10px;
  border-radius: var(--radius-1, 3px);
  cursor: pointer;
  white-space: nowrap;
}
.cm-find-bar-action:hover {
  background-color: var(--paper-2, #f4f4f2);
  border-color: var(--line-3, #a3a29c);
}
.cm-find-bar-action:disabled {
  color: var(--line-3, #a3a29c);
  border-color: var(--line-1, #e3e2dd);
  cursor: default;
  background-color: transparent;
}
.cm-find-bar-lead {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--fg-3, #6b6a64);
}
.cm-find-bar-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  box-sizing: border-box;
  appearance: none;
  -webkit-appearance: none;
  border: 1px solid var(--line-2, #c8c7c1);
  border-radius: var(--radius-1, 3px);
  background: var(--paper, #fbfbfa);
  padding: 0 10px;
  font-family: var(--font-sans);
  font-size: var(--text-base);
  color: var(--fg-1, #1a1a17);
  outline: none;
  box-shadow: none;
}
.cm-find-bar-input::placeholder {
  color: var(--fg-3, #6b6a64);
}
.cm-find-bar-input:focus,
.cm-find-bar-input:focus-visible {
  /* WKWebView applies a default focus ring outline:none alone doesn't always
     clear; belt-and-suspenders, then a subtle accent border (matches the
     frontmatter-properties inputs above). */
  outline: 0 !important;
  outline-style: none !important;
  box-shadow: none !important;
  border-color: var(--accent, #2c4a7a);
}
.cm-find-bar-status {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: var(--text-sm);
  color: var(--fg-3, #6b6a64);
}
.cm-find-bar-status--count {
  font-family: var(--font-mono);
  font-weight: var(--weight-medium);
  font-feature-settings: "ss02", "zero", "calt";
}
.cm-find-bar-status--nomatch {
  font-family: var(--font-sans);
  font-weight: var(--weight-regular);
}
.cm-find-bar-status--hidden {
  display: none;
}
.cm-find-bar-divider {
  flex-shrink: 0;
  width: 1px;
  height: 20px;
  background-color: var(--line-1, #e3e2dd);
}
.cm-find-bar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border: 0;
  background-color: transparent;
  color: var(--fg-2, #3a3934);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  cursor: pointer;
  border-radius: 4px;
}
.cm-find-bar-btn:hover {
  background-color: var(--paper-2, #f4f4f2);
}
.cm-find-bar-btn:disabled {
  color: var(--line-3, #a3a29c);
  cursor: default;
  background-color: transparent;
}
.cm-find-bar-case {
  width: 30px;
  font-weight: var(--weight-medium);
  color: var(--fg-3, #6b6a64);
}
.cm-find-bar-close {
  color: var(--fg-3, #6b6a64);
}
.cm-find-bar-btn-active,
.cm-find-bar-btn-active:hover {
  background-color: var(--paper-3, #ecebe7);
  color: var(--fg-1, #1a1a17);
}
/* Visually-hidden live region (count / no-match announced to screen readers).
   Standard clip-rect hide: removed from view but kept in the accessibility tree. */
.cm-find-bar-a11y {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

/* Opens with a ~180 ms slide-down + fade (the editor reflow is inherent to the
   docked CM panel taking vertical space). Suppressed under prefers-reduced-motion. */
@media (prefers-reduced-motion: no-preference) {
  .cm-find-bar {
    animation: cm-find-bar-in var(--duration-base, 180ms) var(--ease-standard, ease);
  }
}
@keyframes cm-find-bar-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Docked sheet shell (myne-md/myne#884). The task-field sheet and the typeahead
   pickers share it: a full-width surface pinned to the bottom of the VISIBLE
   viewport, over the scrim the caller supplies. The visible height arrives as
   --cm-visible-h, written inline by floating/viewport.ts, so the only decision
   made here is what FRACTION of it the sheet may take before its body scrolls. */
.cm-docked-sheet {
  position: fixed;
  left: 0;
  right: 0;
  /* Written inline on creation. Stated so a host that never measures still paints
     at the right edge rather than at the top. */
  bottom: 0;
  z-index: 2147483000;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  max-height: calc(var(--cm-visible-h, 100vh) * 0.9);
  /* Content width rather than full bleed: on a tablet an edge-to-edge sheet reads
     as a stretched phone. Below this the sheet is simply full width. */
  max-width: 720px;
  margin-inline: auto;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  background: var(--bg-1, #fbfaf7);
  border: 1px solid var(--line-1, #e3e2dd);
  border-bottom: none;
  /* A SHARED token, not a client one: this stylesheet compiles for every client,
     and the three sheets the mobile client already ships all use the shared
     radius step (myne-md/myne#884 review). */
  border-top-left-radius: var(--radius-3, 10px);
  border-top-right-radius: var(--radius-3, 10px);
  box-shadow: var(--shadow-3);
  color: var(--fg-1, #23221e);
  font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
  font-size: var(--text-sm);
}
.cm-docked-sheet-header {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  flex: none;
  padding: var(--space-2, 8px) var(--space-3, 12px);
  border-bottom: 1px solid var(--line-1, #e3e2dd);
}
.cm-docked-sheet-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font-weight: var(--weight-semibold, 600);
  color: var(--fg-1, #23221e);
}
.cm-docked-sheet-back,
.cm-docked-sheet-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: var(--radius-2, 6px);
  background: transparent;
  color: var(--fg-2, #4a4943);
  font-family: inherit;
  font-size: var(--text-lg, 1.125rem);
  line-height: 1;
  cursor: pointer;
}
.cm-docked-sheet-back:hover,
.cm-docked-sheet-close:hover {
  background: var(--paper-2, #eceae4);
  color: var(--fg-1, #23221e);
}
.cm-docked-sheet-back:focus-visible,
.cm-docked-sheet-close:focus-visible {
  outline: 2px solid var(--accent, #2c4a7a);
  outline-offset: 1px;
}
.cm-docked-sheet-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3, 12px);
}
/* A SIBLING of the body, never a child of it. A commit control inside a scroller
   scrolls away, and on a phone with the keyboard up that is the dead end this
   shell exists to remove. An EMPTY one paints nothing: the task-field wizard's
   first step is a list of fields with no action to pin yet, and a hairline-topped
   blank bar under it reads as a broken surface rather than as a step. */
.cm-docked-sheet-actions:empty {
  display: none;
}
.cm-docked-sheet-actions {
  flex: none;
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2, 8px);
  padding: var(--space-2, 8px) var(--space-3, 12px);
  border-top: 1px solid var(--line-1, #e3e2dd);
}
/* The sheet's own controls on a coarse pointer. Sized here rather than from a
   client-only token because this stylesheet compiles for every client; see the
   matching block in task-surfaces.css for the controls inside the body. */
@media (pointer: coarse) {
  .cm-docked-sheet-back,
  .cm-docked-sheet-close {
    width: 44px;
    height: 44px;
  }
}

/* The docked typeahead pickers (myne-md/myne#884, task 5): the slash menu, the
   [[ wikilink picker and the {{ template-token menu, each as the list inside the
   shell above. An anchored picker carries its own popover chrome on
   .cm-slash-menu; docked it must NOT, because the sheet around it already
   supplies the surface, the border and the scroll. So only the stack is declared
   here, and the rows keep the classes they have in both presentations. */
.cm-docked-picker-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
/* Thumb-sized rows on a coarse pointer, the same 44px target the sheet's own
   controls take one block up. */
@media (pointer: coarse) {
  .cm-docked-picker-list .cm-slash-menu-row {
    min-height: 44px;
  }
}
`;

export function ensureFloatingStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID) !== null) return;
  const styleEl = document.createElement("style");
  styleEl.id = STYLE_ID;
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);
}
