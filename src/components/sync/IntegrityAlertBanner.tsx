// Integrity-alert banner (MYND-427 task 3) — the hard, honest alert shown when
// the engine's head-verify rejects a rollback / non-extending head (or a fork
// verdict). SuspicionBanner-class: honest, NOT alarming (PRODUCT.md tone). The
// copy is the load-bearing `SYNC_INTEGRITY_ALERT` literal — rendered verbatim
// (E2E asserts it by full-literal equality). Penpot skipped per the owner
// directive; built against design tokens.

import type { CSSProperties } from "react";
import { SYNC_INTEGRITY_ALERT } from "../../lib/load-bearing-copy";

const STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "flex-start",
  gap: "var(--space-2)",
  background: "var(--warning-soft)",
  border: "1px solid var(--warning)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-4)",
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-1)",
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

interface IntegrityAlertBannerProps {
  /** Whether the alert is active (an integrity failure was raised). */
  present: boolean;
  /** Optional dismiss handler (the alert is acknowledgeable, not blocking). */
  onDismiss?: () => void;
}

export function IntegrityAlertBanner({ present, onDismiss }: IntegrityAlertBannerProps) {
  if (!present) return null;
  return (
    <div role="alert" data-testid="sync.integrity-alert" style={STYLE}>
      <span>{SYNC_INTEGRITY_ALERT}</span>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          style={DISMISS_STYLE}
          data-testid="sync.integrity-alert-dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
}
