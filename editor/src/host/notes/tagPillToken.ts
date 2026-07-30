// Shared tag-pill visual token (tag-system TS-5). The ONE source of the tag
// chip's look, so the tag-browser surface (#2, React inline styles) and the
// editor inline-`#tag` decoration (#3, CodeMirror theme) render a tag
// identically. Values are design tokens (`docs/design/colors_and_type.css`),
// never raw hex. Two variants: quiet (default, in the tree/prose) and selected
// (accent, when the tag is an active filter / hovered click target).

import type { CSSProperties } from "react";

/** Raw token values — also consumed by the CodeMirror theme in #3. */
export const TAG_PILL_TOKEN = {
  bg: "var(--paper-2)",
  bgSelected: "var(--accent-soft)",
  fg: "var(--fg-1)",
  fgSelected: "var(--accent)",
  border: "var(--line-1)",
  radius: "var(--radius-pill)",
  paddingY: 2,
  paddingX: 8,
  fontSize: 12,
  fontWeight: 500,
} as const;

/**
 * The `.cm-tag-chip` CodeMirror theme rules, DERIVED from the token so the
 * editor chip (#3) and the browser's pill rows (#2) never drift (TS-5 — one
 * source). Spread into the `EditorView.theme({...})` object in `editor/theme.ts`.
 */
export function tagChipCmTheme(): Record<string, Record<string, string>> {
  return {
    ".cm-tag-chip": {
      display: "inline-block",
      padding: `${TAG_PILL_TOKEN.paddingY}px ${TAG_PILL_TOKEN.paddingX}px`,
      margin: "0 1px",
      borderRadius: TAG_PILL_TOKEN.radius,
      backgroundColor: TAG_PILL_TOKEN.bg,
      border: `1px solid ${TAG_PILL_TOKEN.border}`,
      color: TAG_PILL_TOKEN.fg,
      fontWeight: String(TAG_PILL_TOKEN.fontWeight),
      fontFamily: "var(--font-sans)",
      fontSize: `${TAG_PILL_TOKEN.fontSize}px`,
      cursor: "pointer",
      verticalAlign: "baseline",
      // `text-indent` is inherited and applies to an inline-block's own first
      // line. Inside a `.cm-list-item-line` (hanging indent: negative `text-indent:
      // -1.5em`) the chip would shift its label left, out of the pill. Reset.
      textIndent: "0",
    },
    ".cm-tag-chip:hover": {
      backgroundColor: TAG_PILL_TOKEN.bgSelected,
      color: TAG_PILL_TOKEN.fgSelected,
    },
  };
}

/** The tag pill as React `CSSProperties` (the #2 surface). */
export function tagPillStyle(selected = false): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
    padding: `${TAG_PILL_TOKEN.paddingY}px ${TAG_PILL_TOKEN.paddingX}px`,
    background: selected ? TAG_PILL_TOKEN.bgSelected : TAG_PILL_TOKEN.bg,
    color: selected ? TAG_PILL_TOKEN.fgSelected : TAG_PILL_TOKEN.fg,
    border: `1px solid ${selected ? "var(--accent-soft)" : TAG_PILL_TOKEN.border}`,
    borderRadius: TAG_PILL_TOKEN.radius,
    fontSize: TAG_PILL_TOKEN.fontSize,
    fontWeight: TAG_PILL_TOKEN.fontWeight,
    lineHeight: 1.4,
    whiteSpace: "nowrap",
  };
}
