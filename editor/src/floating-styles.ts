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
  font-size: 13px;
  color: var(--fg-1);
  max-height: 288px;
  overflow-y: auto;
}
.cm-slash-menu-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-1, 3px);
  cursor: pointer;
}
.cm-slash-menu-row-selected {
  background-color: var(--paper-2, #f3f1eb);
}
.cm-slash-menu-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 20px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-2);
  flex-shrink: 0;
}
.cm-slash-menu-label {
  flex: 1;
}
.cm-slash-menu-kbd {
  font-family: var(--font-mono);
  font-size: 11px;
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
  font-size: 13px;
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
  font-size: 13px;
  font-weight: 500;
  color: var(--fg-1);
  line-height: 1.3;
}
.cm-wiki-picker-path {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-3);
  line-height: 1.2;
}
/* Folder-target row (MYND-370): single line, glyph + path. Overrides the
   note row's column stack with a glyph-then-label horizontal layout. */
.cm-wiki-picker-folder-row {
  flex-direction: row;
  align-items: center;
  gap: 8px;
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
  gap: 8px;
}
.cm-wiki-picker-heading-glyph {
  min-width: 16px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
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
  padding: 4px;
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
  font-size: 13px;
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
  padding: 4px;
  min-width: 120px;
}
.cm-toolbar-heading-item {
  padding: 6px 10px;
  font-size: 13px;
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
  gap: 4px;
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
  margin-top: 4px;
  padding: 4px 6px;
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
  gap: 8px;
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
  font-size: 13px;
  color: var(--fg-1);
  min-width: 200px;
}
.cm-url-overlay-apply {
  border: 0;
  background-color: var(--accent, #2c4a7a);
  color: var(--accent-on, #fff);
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: var(--radius-1, 3px);
  cursor: pointer;
}

.cm-fm-properties {
  padding: 2px 0 16px;
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
.cm-fm-properties textarea {
  user-select: text;
  -webkit-user-select: text;
}
.cm-fm-properties-name {
  display: block;
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  background: transparent;
  outline: 0;
  outline-style: none;
  box-shadow: none;
  font-family: var(--font-sans);
  font-size: 1.571em;
  font-weight: 600;
  line-height: 1.3;
  color: var(--fg-1);
  padding: 2px 6px;
  margin: 0 -6px 10px;
  border-radius: var(--radius-1, 3px);
}
.cm-fm-properties-name::placeholder {
  color: var(--fg-3);
  font-style: italic;
  font-weight: 400;
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
  font-weight: 600;
  color: var(--fg-1);
  margin-bottom: 10px;
}
.cm-fm-properties-list {
  display: grid;
  grid-template-columns: 24px 160px 1fr;
  row-gap: 2px;
  column-gap: 8px;
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
.cm-fm-properties-key {
  width: 100%;
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
  padding: 4px 6px;
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
  padding: 4px 6px;
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
.cm-fm-properties-add {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  margin-left: 24px;
  border: 0;
  background: transparent;
  color: var(--fg-3);
  font-family: var(--font-sans);
  font-size: 0.929em;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: var(--radius-1, 3px);
}
.cm-fm-properties-add:hover {
  background: var(--paper-2, #f3f1eb);
  color: var(--fg-1);
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
  padding: 8px 12px;
  background-color: var(--paper, #fbfbfa);
  border-bottom: 1px solid var(--line-1, #e3e2dd);
  font-family: var(--font-sans);
}
.cm-find-bar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
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
  font-weight: 500;
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
  font-size: 14px;
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
  font-size: 13px;
  color: var(--fg-3, #6b6a64);
}
.cm-find-bar-status--count {
  font-family: var(--font-mono);
  font-weight: 500;
  font-feature-settings: "ss02", "zero", "calt";
}
.cm-find-bar-status--nomatch {
  font-family: var(--font-sans);
  font-weight: 400;
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
  font-size: 13px;
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
  font-weight: 500;
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
`;

export function ensureFloatingStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID) !== null) return;
  const styleEl = document.createElement("style");
  styleEl.id = STYLE_ID;
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);
}
