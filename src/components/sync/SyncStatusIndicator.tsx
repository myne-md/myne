// Sync status indicator + manual "sync now" affordance (MYND-424 task 10).
//
// Penpot was skipped for this surface per the owner directive ("ui kismini da
// yap penpotu bos verip"); the component is built directly against the
// design-token CSS variables (the binding values, never raw hex), consistent
// with the rest of the desktop UI.
//
// Five states (mirroring the Rust `SyncRuntimeStatus`): disabled / idle /
// syncing / error / conflicts. The "Sync now" button is hidden when sync is
// disabled (no endpoint configured) — there is nothing to trigger. Copy is
// resolved through react-i18next (module-level labels resolved at usage time via
// i18n.t() so a language switch is picked up, never frozen at module load).

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { useSyncStatus, type SyncStatus } from "../../hooks/useSyncStatus";
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

interface Presentation {
  dotColor: string;
  label: string;
}

function present(status: SyncStatus | null, notRegistered: boolean): Presentation {
  if (!status) return { dotColor: "var(--fg-3)", label: i18n.t("sync.status.loading") };
  switch (status.state) {
    case "disabled":
      return { dotColor: "var(--fg-3)", label: i18n.t("sync.status.off") };
    case "not_enrolled":
      // The state is DERIVED (no token), so it covers two different facts, and
      // the caller is the only one that can tell them apart: a device that was
      // never added to an account, and an identity that was minted offline and
      // never registered. "Not enrolled" is the vocabulary of the vault account
      // and names no act; on a `reserved` identity the act is Register, which the
      // Identity row above offers by name (2026-10-25 owner report).
      return {
        dotColor: "var(--fg-3)",
        label: i18n.t(notRegistered ? "sync.status.notRegistered" : "sync.status.notEnrolled"),
      };
    case "pending":
      return { dotColor: "var(--accent)", label: i18n.t("sync.status.awaitingApproval") };
    case "idle":
      return { dotColor: "var(--success)", label: i18n.t("sync.status.synced") };
    case "syncing":
      return { dotColor: "var(--accent)", label: i18n.t("sync.status.syncing") };
    case "error":
      // Class-scoped details from the Rust failure gate (FailureClass::status_detail):
      // auth needs the user (re-enroll / re-approve), rate-limit self-heals on the
      // stretched retry — both deserve honest copy instead of a generic "error".
      if (status.detail === "auth_failed") {
        return { dotColor: "var(--danger)", label: i18n.t("sync.status.errorAuth") };
      }
      if (status.detail === "rate_limited") {
        return { dotColor: "var(--warning)", label: i18n.t("sync.status.errorRateLimited") };
      }
      // Refusal classes (MYND-570). Each is a distinct, actionable state — a
      // generic "Sync error" here would hide the one thing the user can act on.
      // All three still PULL; only uploading is blocked.
      if (status.detail === "quota_exceeded") {
        return { dotColor: "var(--danger)", label: i18n.t("sync.status.errorQuota") };
      }
      if (status.detail === "payload_too_large") {
        return { dotColor: "var(--danger)", label: i18n.t("sync.status.errorTooLarge") };
      }
      if (status.detail === "frozen") {
        return { dotColor: "var(--danger)", label: i18n.t("sync.status.errorFrozen") };
      }
      // A shared (`NTV6`) vault refuses to sync until the person identity is
      // unlocked for this session. Separate copy because the
      // fix is a specific user action, and "Sync error" would send them looking
      // at the network instead. The unlock control is the inline phrase entry in
      // this same Sync panel's Identity block (myne-md/myne#831).
      if (status.detail === "identity_locked") {
        return {
          dotColor: "var(--warning)",
          label: i18n.t("sync.status.errorIdentityLocked"),
        };
      }
      // Task 94. NOT folded into `auth_failed`: that copy says the sign-in
      // expired and points at re-enrolling, which is the wrong instruction for a
      // device the account owner deliberately removed from another client. The
      // copy names the act and nothing more — it must never imply that anything
      // was wiped remotely or that a device holding the vault and the password
      // has been locked out, because neither is true (`REMOVE_DEVICE_DISCLOSURE`).
      if (status.detail === "storage_full") {
        // The LOCAL store, not the account's server-side ceiling (task 91).
        // Distinct copy because only one of the two is fixable on this device,
        // and "you're over your storage limit" would send a user to an account
        // page while their disk is what filled up.
        return { dotColor: "var(--warning)", label: i18n.t("sync.status.errorStorageFull") };
      }
      if (status.detail === "device_revoked") {
        return { dotColor: "var(--danger)", label: i18n.t("sync.status.errorDeviceRevoked") };
      }
      if (status.detail === "tls_failure") {
        return { dotColor: "var(--danger)", label: i18n.t("sync.status.errorTls") };
      }
      return { dotColor: "var(--danger)", label: i18n.t("sync.status.error") };
    case "conflicts":
      return {
        dotColor: "var(--warning)",
        label: i18n.t("sync.status.conflicts", { count: status.count }),
      };
  }
}

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
  const { dotColor, label } = present(status, notRegistered);
  const identityLocked =
    status?.state === "error" && status.detail === "identity_locked";
  // Hide "Sync now" when there is nothing to trigger: no endpoint (disabled) OR this
  // device is not enrolled — a cycle there returns NotReady (→ not_enrolled), not a
  // real sync, so the button would be a false promise (and would flash "Synced").
  // A locked person identity is the same kind of "not yet": the cycle refuses
  // before any network call, so "Sync now" cannot help until the identity is
  // unlocked — the unlock button below is the honest action there instead.
  const hideSyncNow =
    status?.state === "disabled" ||
    status?.state === "not_enrolled" ||
    status?.state === "pending" ||
    identityLocked;

  return (
    <div style={ROOT_STYLE} data-testid="sync.status-indicator" data-sync-state={status?.state ?? "loading"}>
      <span style={{ ...DOT_BASE, background: dotColor }} aria-hidden="true" />
      <span style={LABEL_STYLE} data-testid="sync.status-label">
        {label}
      </span>
      {identityLocked && onUnlockIdentity && (
        <Button
          type="button"
          variant="secondary"
          onClick={onUnlockIdentity}
          data-testid="sync.unlock-identity"
        >
          {t("sync.status.unlockIdentityCta")}
        </Button>
      )}
      {!hideSyncNow && (
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
