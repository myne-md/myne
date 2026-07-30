// Shared style constants for the Settings panels (Privacy, Appearance,
// Storage, About). Account uses a separate set in `AccountPanel.tsx`
// because its sections include uppercased eyebrow headings + a danger
// zone — not symmetric with the other four. Hoisting these prevents
// drift across the four panels that DO share the label-control-helper
// shape.

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
};

export const HELPER_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-3)",
  margin: 0,
};

/** Label on the left, control (usually a `Switch`) on the right. */
export const TOGGLE_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

/** One folder per line, mono — the excluded-folders editor shape shared by
 *  the AI panel and the CLI terminal-access block. */
export const FOLDER_TEXTAREA_STYLE: CSSProperties = {
  marginTop: "var(--space-1)",
  width: "100%",
  resize: "vertical",
  font: "inherit",
  fontSize: 13,
  fontFamily: "var(--font-mono)",
  color: "var(--fg-1)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "var(--space-2)",
};
