// Sync status indicator + manual "sync now" affordance (MYND-424 task 10).
//
// Penpot was skipped for this surface per the owner directive ("ui kismini da
// yap penpotu bos verip"); the component is built directly against the
// design-token CSS variables (the binding values, never raw hex), consistent
// with the rest of the desktop UI.
//
// Six states (mirroring the Rust `SyncRuntimeStatus`): disabled / not_enrolled /
// pending / idle / syncing / error / conflicts, plus `uploads_blocked` for a cycle
// that RUNS and cannot upload (myne-md/myne#1027).
//
// What this component owns is LAYOUT. The sentence, the dot colour, which repair is
// offered and whether "Sync now" can keep its promise all come from
// `src/lib/sync-status-view.ts`, which is the one place any client maps a status to
// words, the phone and the browser consume the same function, so a state cannot read
// as "Synced" here and "On" there.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useSyncStatus } from "../../hooks/useSyncStatus";
import { syncStatusView } from "../../lib/sync-status-view";
import { HOVER_TRANSITION } from "../primitives/hoverSurface";
import { interactiveSurface } from "../primitives/interactiveSurface";
import { Button } from "../primitives/Button";

const ROOT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "var(--space-2)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const DOT_BASE: CSSProperties = {
  width: "8px",
  height: "8px",
  borderRadius: "var(--radius-pill)",
  flexShrink: 0,
};

const LABEL_STYLE: CSSProperties = {
  whiteSpace: "nowrap",
};

const BUTTON_STYLE: CSSProperties = {
  marginInlineStart: "var(--space-2)",
  padding: "var(--space-1) var(--space-2)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  cursor: "pointer",
  transition: HOVER_TRANSITION,
};

export interface SyncStatusIndicatorProps {
  /**
   * Offered only while sync is parked on a locked person identity (`NTV6`, the
   * `identity_locked` detail): opens the Sync panel's inline person-identity
   * phrase entry (myne-md/myne#831). Optional so an isolated render (a component
   * test) still shows just the label.
   */
  onUnlockIdentity?: () => void;
  /**
   * Whether the active identity was minted offline and never registered
   * (`reserved`). It only re-labels `not_enrolled`, because that state is derived
   * from the absence of a token and cannot tell “never added” from “never
   * registered”; the panel that knows says which. Default `false`, so an
   * isolated render keeps the vault-account reading.
   */
  notRegistered?: boolean;
}

export function SyncStatusIndicator({
  onUnlockIdentity,
  notRegistered = false,
}: SyncStatusIndicatorProps = {}) {
  const { t } = useTranslation();
  const { status, syncNow, busy } = useSyncStatus();
  // One mapping for every client (myne-md/myne#1027). It decides the sentence, the colour, WHICH
  // repair is offered and whether "Sync now" is a promise this state can keep; before it, this
  // component held the only copy and the phone held a second, already different one.
  const view = syncStatusView(status, t, { notRegistered });
  const { dotColor, label, action, syncNowUseful } = view;

  return (
    <div style={ROOT_STYLE} data-testid="sync.status-indicator" data-sync-state={status?.state ?? "loading"}>
      <span style={{ ...DOT_BASE, background: dotColor }} aria-hidden="true" />
      <span style={LABEL_STYLE} data-testid="sync.status-label">
        {label}
      </span>
      {action && onUnlockIdentity && (
        <Button
          type="button"
          variant="secondary"
          onClick={onUnlockIdentity}
          data-testid="sync.unlock-identity"
        >
          {action === "repair_device"
            ? t("sync.status.repairDeviceCta")
            : t("sync.status.unlockIdentityCta")}
        </Button>
      )}
      {syncNowUseful && (
        <button
          type="button"
          style={{ ...BUTTON_STYLE, opacity: busy ? 0.6 : 1 }}
          {...interactiveSurface({
            restBg: "var(--bg-2)",
            hoverBg: "var(--paper-3)",
            disabled: busy,
          })}
          onClick={() => void syncNow()}
          disabled={busy}
          data-testid="sync.sync-now"
        >
          {busy ? t("sync.status.syncing") : t("sync.status.syncNow")}
        </button>
      )}
    </div>
  );
}
