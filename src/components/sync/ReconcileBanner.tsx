// Non-blocking reconcile banner (MYND-426 task 5) — a reassuring, one-time
// "this device was offline a while, re-syncing" notice shown during a background
// full-reconcile (410 cursor-expired / soft-retire return). RepairResidueBanner
// pattern: informational, dismissable, NEVER implies data loss, never blocks the
// editor. Penpot skipped per the owner directive; built against design tokens.

import type { CSSProperties } from "react";

const STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "var(--space-2)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-2) var(--space-4)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const DISMISS_STYLE: CSSProperties = {
  marginInlineStart: "auto",
  background: "transparent",
  border: 0,
  color: "var(--fg-3)",
  cursor: "pointer",
  fontSize: "var(--text-lg)",
  lineHeight: 1,
  padding: "0 var(--space-1)",
};

// Reassuring, non-alarming — re-syncing is routine, not a problem.
const MESSAGE = "This device was offline for a while — catching up on sync. Your notes are safe.";

interface ReconcileBannerProps {
  /** Whether a background reconcile is in progress. */
  active: boolean;
  /** Dismiss handler (the banner is non-blocking + dismissable). */
  onDismiss?: () => void;
}

export function ReconcileBanner({ active, onDismiss }: ReconcileBannerProps) {
  if (!active) return null;
  return (
    <div role="status" data-testid="sync.reconcile-banner" style={STYLE}>
      <span>{MESSAGE}</span>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          style={DISMISS_STYLE}
          data-testid="sync.reconcile-banner-dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
}
