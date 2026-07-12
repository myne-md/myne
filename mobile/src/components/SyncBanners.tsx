// Mobile sync banners (MYND-461) — two honest, non-blocking, dismissable banners
// above the note list, driven by the `use-sync-status` hook:
//   • ReconcileBanner       — lit ONLY during a real reconcile (`reconciling`),
//     never on ordinary sync ticks, and never implies data loss (SYNC-6).
//   • IntegrityAlertBanner  — renders the load-bearing `SYNC_INTEGRITY_ALERT`
//     literal VERBATIM (a privacy/honesty property, E2E full-literal-asserted;
//     `threat-model.md` §5.5) with a "Verify devices" CTA that routes to the
//     approve-then-verify device surface (SYNC-40).
// Direct-to-code per the owner directive; mobile has no i18n → plain strings,
// EXCEPT the load-bearing literal, which is never i18n'd or paraphrased anyway.

import { useEffect, useState, type CSSProperties } from "react";
import { useSyncStatus } from "../lib/use-sync-status";
import { SYNC_INTEGRITY_ALERT } from "../lib/load-bearing-copy";

const DISMISS: CSSProperties = {
  marginInlineStart: "auto",
  background: "transparent",
  border: 0,
  color: "var(--fg-3)",
  cursor: "pointer",
  fontSize: "var(--text-lg)",
  lineHeight: 1,
  padding: "0 var(--space-1)",
  flexShrink: 0,
};

const RECONCILE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-2) var(--space-4)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const INTEGRITY: CSSProperties = {
  display: "flex",
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

const CTA: CSSProperties = {
  marginTop: "var(--space-2)",
  alignSelf: "flex-start",
  background: "transparent",
  border: "1px solid var(--warning)",
  borderRadius: "var(--radius-2)",
  color: "var(--fg-1)",
  cursor: "pointer",
  padding: "var(--space-1) var(--space-3)",
  fontSize: "var(--text-sm)",
  fontWeight: 600,
  fontFamily: "var(--font-sans)",
};

// Conflicts count banner (CF-02). Danger-tinted, tappable → the ConflictsView.
// This banner is the ONLY spec-compatible conflict entry point — a per-note
// in-feed badge is forbidden by the dialect §3.6.1 feed-exclusion rule.
const CONFLICT: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  textAlign: "start",
  background: "var(--danger-soft, var(--warning-soft))",
  border: "1px solid var(--danger)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-2) var(--space-4)",
  fontSize: "var(--text-sm)",
  fontWeight: 600,
  color: "var(--danger)",
  fontFamily: "var(--font-sans)",
  cursor: "pointer",
};

export interface SyncBannersProps {
  /** Route to the approve-then-verify device surface (SYNC-40; MYND-459 T12/T13). */
  onVerifyDevices?: () => void;
  /** Route to the ConflictsView (MYND-461 T8). */
  onOpenConflicts?: () => void;
}

/** Host: the three banners above the note list, driven by the shared hook. */
export function SyncBanners({ onVerifyDevices, onOpenConflicts }: SyncBannersProps) {
  const { status, reconciling, integrityAlert } = useSyncStatus();
  const [reconcileDismissed, setReconcileDismissed] = useState(false);
  const [integrityDismissed, setIntegrityDismissed] = useState(false);

  // Re-arm the reconcile dismiss when a reconcile ends, so the NEXT reconcile
  // shows again (the integrity alert stays acknowledged — it does not auto-clear).
  useEffect(() => {
    if (!reconciling) setReconcileDismissed(false);
  }, [reconciling]);

  const conflictCount = status?.state === "conflicts" ? status.count : 0;
  const showReconcile = reconciling && !reconcileDismissed;
  const showIntegrity = integrityAlert && !integrityDismissed;
  const showConflicts = conflictCount > 0;
  if (!showReconcile && !showIntegrity && !showConflicts) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {showConflicts && (
        <button
          type="button"
          onClick={onOpenConflicts}
          style={CONFLICT}
          data-testid="sync.conflict-count-banner"
        >
          {conflictCount} conflict{conflictCount === 1 ? "" : "s"} need review
        </button>
      )}
      {showReconcile && (
        <div role="status" data-testid="sync.reconcile-banner" style={RECONCILE}>
          {/* Reassuring, non-alarming — re-syncing is routine, never data loss. */}
          <span>Catching up on sync — your notes are safe.</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setReconcileDismissed(true)}
            style={DISMISS}
            data-testid="sync.reconcile-banner-dismiss"
          >
            ×
          </button>
        </div>
      )}
      {showIntegrity && (
        <div role="alert" data-testid="sync.integrity-alert" style={INTEGRITY}>
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            {/* Load-bearing literal — rendered VERBATIM, never paraphrased. */}
            <span data-testid="sync.integrity-alert-copy">{SYNC_INTEGRITY_ALERT}</span>
            {onVerifyDevices && (
              <button
                type="button"
                onClick={onVerifyDevices}
                style={CTA}
                data-testid="sync.integrity-verify-devices"
              >
                Verify devices
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setIntegrityDismissed(true)}
            style={DISMISS}
            data-testid="sync.integrity-alert-dismiss"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
