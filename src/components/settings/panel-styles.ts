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
