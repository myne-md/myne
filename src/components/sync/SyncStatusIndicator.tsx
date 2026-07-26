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
};

interface Presentation {
  dotColor: string;
  label: string;
}

function present(status: SyncStatus | null): Presentation {
  if (!status) return { dotColor: "var(--fg-3)", label: i18n.t("sync.status.loading") };
  switch (status.state) {
    case "disabled":
      return { dotColor: "var(--fg-3)", label: i18n.t("sync.status.off") };
    case "not_enrolled":
      return { dotColor: "var(--fg-3)", label: i18n.t("sync.status.notEnrolled") };
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
      return { dotColor: "var(--danger)", label: i18n.t("sync.status.error") };
    case "conflicts":
      return {
        dotColor: "var(--warning)",
        label: i18n.t("sync.status.conflicts", { count: status.count }),
      };
  }
}

export function SyncStatusIndicator() {
  const { t } = useTranslation();
  const { status, syncNow, busy } = useSyncStatus();
  const { dotColor, label } = present(status);
  // Hide "Sync now" when there is nothing to trigger: no endpoint (disabled) OR this
  // device is not enrolled — a cycle there returns NotReady (→ not_enrolled), not a
  // real sync, so the button would be a false promise (and would flash "Synced").
  const hideSyncNow =
    status?.state === "disabled" ||
    status?.state === "not_enrolled" ||
    status?.state === "pending";

  return (
    <div style={ROOT_STYLE} data-testid="sync.status-indicator" data-sync-state={status?.state ?? "loading"}>
      <span style={{ ...DOT_BASE, background: dotColor }} aria-hidden="true" />
      <span style={LABEL_STYLE} data-testid="sync.status-label">
        {label}
      </span>
      {!hideSyncNow && (
        <button
          type="button"
          style={{ ...BUTTON_STYLE, opacity: busy ? 0.6 : 1 }}
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
