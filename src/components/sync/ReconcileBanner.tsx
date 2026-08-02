// Non-blocking reconcile banner (MYND-426 task 5) — a reassuring, one-time
// "this device was offline a while, re-syncing" notice shown during a background
// full-reconcile (410 cursor-expired / soft-retire return). RepairResidueBanner
// pattern: informational, dismissable, NEVER implies data loss, never blocks the
// editor. Penpot skipped per the owner directive; built against design tokens.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { hoverSurface, HOVER_TRANSITION } from "../primitives/hoverSurface";

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
  transition: HOVER_TRANSITION,
};

interface ReconcileBannerProps {
  /** Whether a background reconcile is in progress. */
  active: boolean;
  /** Dismiss handler (the banner is non-blocking + dismissable). */
  onDismiss?: () => void;
}

export function ReconcileBanner({ active, onDismiss }: ReconcileBannerProps) {
  const { t } = useTranslation();
  if (!active) return null;
  // Reassuring, non-alarming — re-syncing is routine, not a problem.
  return (
    <div role="status" data-testid="sync.reconcile-banner" style={STYLE}>
      <span>{t("sync.reconcile.message")}</span>
      {onDismiss && (
        <button
          type="button"
          aria-label={t("common.dismiss")}
          onClick={onDismiss}
          style={DISMISS_STYLE}
          {...hoverSurface()}
          data-testid="sync.reconcile-banner-dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
}
