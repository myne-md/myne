// Shared chrome styles for the vault-collection modal panels — Trash (MYND-133)
// and Archive (MYND-331). Both panels render the same backdrop-card shell
// (header + count, scrollable row list, per-row title/age, footer), so the
// inert style constants live here once instead of being copy-pasted per panel.
// Panel-specific buttons (Trash's purge/empty, each panel's Close variant) stay
// local to their component.

import type { CSSProperties } from "react";

export const PANEL_STYLE: CSSProperties = {
  width: 460,
  maxHeight: "70vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-3)",
  boxShadow: "var(--shadow-3)",
  fontFamily: "var(--font-sans)",
  overflow: "hidden",
};

export const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  padding: "var(--space-4) var(--space-5)",
  borderBottom: "1px solid var(--line-1)",
};

export const HEADER_TITLE_STYLE: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "var(--fg-1)",
  margin: 0,
};

export const COUNT_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
};

export const LIST_STYLE: CSSProperties = {
  overflowY: "auto",
  padding: "var(--space-2) 0",
  flex: 1,
};

export const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-2) var(--space-5)",
};

export const ROW_TITLE_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  color: "var(--fg-1)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

export const AGE_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-3)",
  flexShrink: 0,
};

export const ROW_BTN_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  fontWeight: 500,
  padding: "4px 8px",
  borderRadius: 5,
  cursor: "pointer",
  border: "1px solid var(--line-2)",
  background: "var(--paper-2)",
  color: "var(--fg-1)",
  flexShrink: 0,
};

export const EMPTY_STATE_STYLE: CSSProperties = {
  padding: "var(--space-7) var(--space-5)",
  textAlign: "center",
  fontSize: 13,
  color: "var(--fg-3)",
};

export const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "var(--space-3) var(--space-5)",
  borderTop: "1px solid var(--line-1)",
};

export const STATUS_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--warning)",
};
