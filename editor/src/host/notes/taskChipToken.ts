// Shared task-chip visual token (MYND-614). The ONE source of a task field's
// chip look, so the editor's inline chips and the later task-panel rows cannot
// drift. Values are design tokens (`agent-tooling/docs/design/colors_and_type.css`), never raw
// hex - the `tagPillToken` twin.
//
// Visual direction, per the canon:
//   - **pill radius**, matching the shipped editor chip;
//   - **neutral fill** - the canon forbids state-as-fill, so a chip's background
//     never encodes overdue / done / priority;
//   - state, when it exists, is carried by an icon and coloured *text*;
//   - **no green check**, anywhere, ever.

import type { CSSProperties } from "react";

/** Raw token values - also consumed by the CodeMirror theme below. */
export const TASK_CHIP_TOKEN = {
  /** Neutral, always. State is never carried by the fill. */
  bg: "var(--paper-2)",
  bgHover: "var(--paper-3)",
  fg: "var(--fg-1)",
  /**
   * The chip's label/icon ink. Reads the `--task-chip-ink` variable when the
   * task-display setting has set one (myne-md/myne#656 item 4), and falls back
   * to `--fg-1`. Resolved through CSS, so the editor's inline chips and the
   * panel rows follow ONE value set at the document root, with no per-surface
   * plumbing and no theme recompilation.
   */
  ink: "var(--task-chip-ink, var(--fg-1))",
  /** Muted ink for the field's leading glyph / key. */
  fgMuted: "var(--fg-3)",
  border: "var(--line-1)",
  radius: "var(--radius-pill)",
  // Metrics in `em`, NOT px, so the chip tracks `--editor-text-size` rather
  // than assuming 14px (myne-md/myne#656 item 1, the same discipline #560
  // applied to the `+` affordance). A px box that merely fits at the default
  // typography grows the row again at the small text size or the tight line
  // spacing, because the chip is inline content and the row is what pays.
  paddingY: "0.167em",
  paddingX: "0.667em",
  fontSize: "0.857em",
  // Pinned rather than inherited, so the chip's own border-box height is a
  // known multiple of its font-size and the block-margin cancellation below can
  // name it. `1em` content + `2 * paddingY` + a 2px border.
  lineHeight: "1.4",
  fontWeight: "var(--weight-medium)",
} as const;

/**
 * Half the chip's border-box height, negated - the negative block margin that
 * makes its margin box zero-height while its border box keeps a real height.
 *
 * The line box is laid out from the MARGIN box (that is #560's whole mechanism,
 * recorded at length beside `.cm-task-add` in `task-surfaces.css`), so a
 * symmetric negative margin equal to half the height removes the chip's
 * contribution to the row without changing how it looks. Every term is `em` of
 * the chip's own font-size except the border, which is a fixed 1px on each side:
 *
 *   height = lineHeight 1.4em + 2 * paddingY 0.167em + 2px = 1.734em + 2px
 *   half   = 0.867em + 1px
 *
 * Kept beside the token it is derived from, so changing `lineHeight` or
 * `paddingY` without revisiting this is visibly a two-line edit rather than a
 * one-line one.
 */
const CHIP_BLOCK_CANCEL = "calc(-0.867em - 1px)";

/**
 * The `.cm-task-chip` CodeMirror theme rules, DERIVED from the token so the
 * editor chips and the panel rows never diverge. Spread into the
 * `EditorView.theme({...})` object in `editor/src/theme.ts`.
 */
export function taskChipCmTheme(): Record<string, Record<string, string>> {
  return {
    ".cm-task-chip": {
      // inline-flex so the leading icon and the label sit on one centred line;
      // still an inline-level box, so the zero-height margin box below keeps
      // working.
      display: "inline-flex",
      alignItems: "center",
      gap: "0.33em",
      padding: `${TASK_CHIP_TOKEN.paddingY} ${TASK_CHIP_TOKEN.paddingX}`,
      marginInline: "1px",
      // The zero-height margin box (see `CHIP_BLOCK_CANCEL`): the row is laid
      // out from the margin box, so the chip stops making its line taller than
      // its neighbours' while the chip itself still measures its real height.
      marginBlock: CHIP_BLOCK_CANCEL,
      borderRadius: TASK_CHIP_TOKEN.radius,
      backgroundColor: TASK_CHIP_TOKEN.bg,
      border: `1px solid ${TASK_CHIP_TOKEN.border}`,
      color: TASK_CHIP_TOKEN.ink,
      fontWeight: String(TASK_CHIP_TOKEN.fontWeight),
      fontFamily: "var(--font-sans)",
      fontSize: TASK_CHIP_TOKEN.fontSize,
      lineHeight: TASK_CHIP_TOKEN.lineHeight,
      cursor: "pointer",
      // Middle, not baseline. A baseline-aligned box taller than the text pushes
      // its line taller - the reported defect. With the margin box reduced to a
      // point above, `middle` centres the real box on the text's midpoint
      // without contributing height at any `--editor-line-spacing`.
      verticalAlign: "middle",
      // Inherited `text-indent` from a list item's hanging indent would shift
      // the label out of the pill - the same trap the tag chip documents, and
      // one of the two layout carve-outs MYND-614 task 9 is about.
      textIndent: "0",
    },
    ".cm-task-chip-icon": {
      width: "1em",
      height: "1em",
      flex: "0 0 auto",
    },
    // Icon-only mode (myne-md/myne#656 item 5): the label is always in the DOM
    // and hidden here, so flipping the setting is a root-attribute change with
    // no widget rebuild and no CodeMirror reconfiguration. Scoped to priority.
    "[data-task-chip-icon-only] .cm-task-chip-priority .cm-task-chip-label": {
      display: "none",
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

/** The task chip as React `CSSProperties` - for the panel rows (MYND-616). */
export function taskChipStyle(): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-1)",
    padding: `${TASK_CHIP_TOKEN.paddingY} ${TASK_CHIP_TOKEN.paddingX}`,
    background: TASK_CHIP_TOKEN.bg,
    color: TASK_CHIP_TOKEN.ink,
    border: `1px solid ${TASK_CHIP_TOKEN.border}`,
    borderRadius: TASK_CHIP_TOKEN.radius,
    fontSize: TASK_CHIP_TOKEN.fontSize,
    fontWeight: TASK_CHIP_TOKEN.fontWeight,
    // The same `lineHeight` the editor rule uses, so the two surfaces cannot
    // drift on the one metric the block-margin cancellation is derived from.
    // The panel needs no negative margin: its row is a flex box, not a line box.
    lineHeight: TASK_CHIP_TOKEN.lineHeight,
    whiteSpace: "nowrap",
  };
}
