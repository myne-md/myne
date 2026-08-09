// Shared chrome styles for the vault-collection modal panels — Trash (MYND-133)
// and Archive (MYND-331). Both panels render the same backdrop-card shell
// (header + count, scrollable row list, per-row title/age, footer), so the
// inert style constants live here once instead of being copy-pasted per panel.
// Panel-specific buttons (Trash's purge/empty, each panel's Close variant) stay
// local to their component.

import type { CSSProperties } from "react";

export const PANEL_STYLE: CSSProperties = {
  // A touch larger than before (was 460 / 70vh) — the row list + polished empty
  // state read cramped at the old size (#226 follow-up polish).
  width: 560,
  height: "min(78vh, 720px)",
  maxHeight: "78vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-3)",
  boxShadow: "var(--shadow-3)",
  fontFamily: "var(--font-sans)",
  overflow: "hidden",
  // Opens with the same rise + fade as the Settings modal (reuses its keyframe)
  // instead of popping in instantly (#226 follow-up). Reduced-motion is
  // handled by the guard in tokens.css keyed on the panel testids.
  animation: "settings-modal-in var(--duration-base) var(--ease-standard)",
};

export const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "var(--space-3) var(--space-3) var(--space-3) var(--space-5)",
  borderBottom: "1px solid var(--line-1)",
};

/** Title + count group on the left of the header. */
export const HEADER_LEFT_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--space-2)",
  minWidth: 0,
};

/** Action cluster on the right of the header (Empty-trash + close ✕). */
export const HEADER_RIGHT_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flexShrink: 0,
};

/** Header close ✕ — replaces the old footer Close button (#226 follow-up:
 *  the modal now closes from the header like Settings, and the bottom row is
 *  gone). Ghost icon button; brightens on hover via `[data-panel-action="close"]`. */
export const HEADER_CLOSE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  borderRadius: 7,
  cursor: "pointer",
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--fg-3)",
  flexShrink: 0,
};

/** Slim, conditional status line (an error / partial-failure message), shown
 *  just under the header only when present — the footer that used to hold it is
 *  gone. */
export const STATUS_LINE_STYLE: CSSProperties = {
  padding: "var(--space-2) var(--space-5)",
  fontSize: 12,
  color: "var(--warning)",
  borderBottom: "1px solid var(--line-1)",
  flexShrink: 0,
};

export const HEADER_TITLE_STYLE: CSSProperties = {
  fontSize: 15,
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
  margin: 0,
};

export const COUNT_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-3)",
  background: "var(--paper-3)",
  borderRadius: "var(--radius-pill)",
  padding: "2px 8px",
};

// Per-row action: a ghost icon button (restore / delete). Subtle by default,
// brightens on hover/focus (tokens.css `.note-panel-icon-btn`). Replaces the
// always-loud text buttons ("Restore" / "Delete") the panels used to show.
export const ROW_ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  flexShrink: 0,
};
export const ROW_ICON_BTN_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  borderRadius: 7,
  cursor: "pointer",
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--fg-3)",
  flexShrink: 0,
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
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

export const AGE_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  flexShrink: 0,
};

export const ROW_BTN_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  fontWeight: "var(--weight-medium)",
  padding: "4px 8px",
  borderRadius: 5,
  cursor: "pointer",
  border: "1px solid var(--line-2)",
  background: "var(--paper-2)",
  color: "var(--fg-1)",
  flexShrink: 0,
};

// The Archive folder-delete armed state used to be an inline danger-tinted band
// (ROW_CONFIRM_STYLE / ROW_CONFIRM_TEXT_STYLE / ROW_BTN_DANGER_STYLE, MYND-623).
// #202 routed that action through the shared <DeleteConfirmModal> instead — one
// destructive-confirm surface across the app, with a token-correct danger fill
// (no var(--paper-1,#fff) ghost), a focus trap and Cancel-default focus — so the
// three inline styles are gone.

// A proper zero state (#226 follow-up): a large muted glyph, a headline,
// and one explanatory line — instead of a single bare sentence. Shared by both
// panels via `<PanelEmptyState>`.
export const EMPTY_STATE_STYLE: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--space-3)",
  padding: "var(--space-7) var(--space-6)",
  textAlign: "center",
};
export const EMPTY_ICON_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  opacity: 0.55,
  marginBottom: "var(--space-1)",
};
export const EMPTY_TITLE_STYLE: CSSProperties = {
  fontSize: 15,
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-2)",
  margin: 0,
};
export const EMPTY_BODY_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  maxWidth: 340,
  lineHeight: 1.5,
  margin: 0,
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
