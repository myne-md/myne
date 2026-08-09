// Shared style constants for the Settings panels. Account uses a separate set
// in `AccountPanel.tsx` because its sections include uppercased eyebrow
// headings + a danger zone — not symmetric with the rest. Hoisting these
// prevents drift across the panels that DO share the label-control-helper
// shape.
//
// These are the parts, not the shape. The shape is a component: `SettingRow`
// (label left / control right / helper below) is the canonical one and
// `ControlBlock` (stacked) the documented exception — see `SettingRow.tsx`.
// Compose those rather than re-assembling `BLOCK_STYLE` + `TOGGLE_ROW_STYLE`
// by hand, which is how seven panels each ended up with a private copy of the
// same row.

import type { CSSProperties } from "react";

export const PANEL_ROOT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
  alignSelf: "flex-start",
  width: "100%",
};

export const BLOCK_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  alignSelf: "stretch",
};

export const LABEL_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
  // In a row the label is the flexible cell: it wraps rather than shoving the
  // control past the panel's right edge. A flex item's default `min-width:auto`
  // refuses to shrink below its longest word, which is what would push a
  // 320px-wide dropdown out of view in the longer locales.
  minWidth: 0,
};

export const HELPER_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-3)",
  margin: 0,
};

/** Label on the left, control (usually a `Switch`) on the right. Prefer the
 *  `SettingRow` component, which composes this with the block + helper; reach
 *  for the bare const only inside a control that needs its own inner row. */
export const TOGGLE_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

/** The row's right-hand cell. Holds the control (or a small cluster of them)
 *  at its natural width and never shrinks — the label is the flexible cell, so
 *  a long label wraps instead of squeezing the control.
 *
 *  Deliberately NOT capped here. Every control the row accepts is already
 *  bounded by its own styles (`Switch` 36px, `Select`/`SearchableSelect` a
 *  320px trigger, `Segmented` by its option count, a `Button` by its label),
 *  and a cap on the slot would clip rather than shrink them — a four-option
 *  `Segmented` runs to ~320px in English and past it in the longer locales. */
export const CONTROL_SLOT_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flexShrink: 0,
};

/** Save-failure text under a control. Was declared, byte-identically, in a
 *  dozen panels before it was hoisted here. */
export const ERROR_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

/** One folder per line, mono — the excluded-folders editor shape shared by
 *  the AI panel and the CLI terminal-access block. */
export const FOLDER_TEXTAREA_STYLE: CSSProperties = {
  marginTop: "var(--space-1)",
  width: "100%",
  resize: "vertical",
  font: "inherit",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  color: "var(--fg-1)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "var(--space-2)",
};
