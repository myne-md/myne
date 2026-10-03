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

/** Narrow-dialog restack of {@link TOGGLE_ROW_STYLE} (#391): the control moves
 *  UNDER the label instead of beside it, so the two never share pixels when the
 *  label cell would otherwise shrink past its text. `SettingRow` swaps to this
 *  under {@link useSettingsCompact}; the control cell aligns to the start so it
 *  reads as its own line rather than hugging the right edge. */
export const TOGGLE_ROW_COMPACT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "var(--space-2)",
};

/** The row's right-hand cell. Holds the control (or a small cluster of them)
 *  at its natural width and never shrinks — the label is the flexible cell, so
 *  a long label wraps instead of squeezing the control.
 *
 *  Deliberately NOT capped here. Every control the row accepts is already
 *  bounded by its own styles (`Switch` 36px, `Select`/`SearchableSelect` a
 *  320px trigger, a `Button` by its label), and a cap on the slot would clip
 *  rather than shrink them. Every row-level picker is a `Select` since
 *  myne-md/myne#769, so the widest case is now one trigger rather than a
 *  four-option `Segmented` running past 320px in the longer locales — which is
 *  part of why the override exists (docs/design/README.md "Which picker"). */
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

/** The multi-line text field shape: one value per line, monospace, resizable
 *  vertically. Carries every colour and metric from the shared tokens, so a
 *  textarea never falls back to the WebView's default white field on a dark
 *  panel (#767).
 *
 *  Its users are the excluded-folders editors (the AI panel and the CLI
 *  terminal-access block) and the two B2B identity-code fields — the invite box
 *  in the member roster and the accept box on the identity home, which are the
 *  two ends of one handshake and were BOTH unstyled. They were two unstyled
 *  `<textarea>`s and one private copy in `MemorySection`, so the drift this
 *  closes is the same one `panel-styles.ts`'s own header describes for the
 *  setting row: a shape re-assembled per call site instead of composed from.
 *
 *  `marginTop` is here rather than at the call sites because moving it would
 *  shift the two editors it predates. */
export const MULTILINE_STYLE: CSSProperties = {
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
