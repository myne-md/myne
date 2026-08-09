// Shared task-chip visual token (MYND-614). The ONE source of a task field's
// chip look, so the editor's inline chips and the later task-panel rows cannot
// drift. Values are design tokens (`docs/design/colors_and_type.css`), never raw
// hex — the `tagPillToken` twin.
//
// Visual direction, per the canon:
//   - **pill radius**, matching the shipped editor chip;
//   - **neutral fill** — the canon forbids state-as-fill, so a chip's background
//     never encodes overdue / done / priority;
//   - state, when it exists, is carried by an icon and coloured *text*;
//   - **no green check**, anywhere, ever.

import type { CSSProperties } from "react";

/** Raw token values — also consumed by the CodeMirror theme below. */
export const TASK_CHIP_TOKEN = {
  /** Neutral, always. State is never carried by the fill. */
  bg: "var(--paper-2)",
  bgHover: "var(--paper-3)",
  fg: "var(--fg-1)",
  /** Muted ink for the field's leading glyph / key. */
  fgMuted: "var(--fg-3)",
  border: "var(--line-1)",
  radius: "var(--radius-pill)",
  paddingY: 2,
  paddingX: 8,
  fontSize: 12,
  fontWeight: "var(--weight-medium)",
} as const;

/**
 * The `.cm-task-chip` CodeMirror theme rules, DERIVED from the token so the
 * editor chips and the panel rows never diverge. Spread into the
 * `EditorView.theme({...})` object in `editor/src/theme.ts`.
 */
export function taskChipCmTheme(): Record<string, Record<string, string>> {
  return {
    ".cm-task-chip": {
      display: "inline-block",
      padding: `${TASK_CHIP_TOKEN.paddingY}px ${TASK_CHIP_TOKEN.paddingX}px`,
      margin: "0 1px",
      borderRadius: TASK_CHIP_TOKEN.radius,
      backgroundColor: TASK_CHIP_TOKEN.bg,
      border: `1px solid ${TASK_CHIP_TOKEN.border}`,
      color: TASK_CHIP_TOKEN.fg,
      fontWeight: String(TASK_CHIP_TOKEN.fontWeight),
      fontFamily: "var(--font-sans)",
      fontSize: `${TASK_CHIP_TOKEN.fontSize}px`,
      cursor: "pointer",
      verticalAlign: "baseline",
      // Inherited `text-indent` from a list item's hanging indent would shift
      // the label out of the pill — the same trap the tag chip documents, and
      // one of the two layout carve-outs MYND-614 task 9 is about.
      textIndent: "0",
    },
    ".cm-task-chip:hover": {
      backgroundColor: TASK_CHIP_TOKEN.bgHover,
    },
    ".cm-task-chip:focus-visible": {
      outline: "2px solid var(--accent)",
      outlineOffset: "1px",
    },
  };
}

/** The task chip as React `CSSProperties` — for the panel rows (MYND-616). */
export function taskChipStyle(): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-1)",
    padding: `${TASK_CHIP_TOKEN.paddingY}px ${TASK_CHIP_TOKEN.paddingX}px`,
    background: TASK_CHIP_TOKEN.bg,
    color: TASK_CHIP_TOKEN.fg,
    border: `1px solid ${TASK_CHIP_TOKEN.border}`,
    borderRadius: TASK_CHIP_TOKEN.radius,
    fontSize: TASK_CHIP_TOKEN.fontSize,
    fontWeight: TASK_CHIP_TOKEN.fontWeight,
    lineHeight: 1.4,
    whiteSpace: "nowrap",
  };
}
