// Settings → Sync usage block (MYND-570): storage used against its effective
// ceiling, enrolled devices against their cap, and the operator-freeze badge.
//
// Three renders, driven entirely by server data:
//   - ceiling present  → figures + meter
//   - ceiling unlimited (`0`) → figures only, NO meter, no limit language.
//     This is the self-hosted / no-ceiling state: neutral, error-free, and with
//     no hosted-only concept or upsell anywhere (MYND-496 epic invariant).
//   - frozen → an additional badge stating pushes are blocked and pulls are not.
//
// No plan name, price, SKU or quota literal exists in this file by design — the
// client repo is destined to go public and its git history is permanent. Every
// number arrives from `/account/status` and is rendered as data.
//
// Penpot skipped per the owner directive (grill 2026-07-25 Q12) — the meter is
// built from design tokens, same posture as `SyncPanel.tsx` itself.

import { type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "../attachments/format";
import { isUnlimited, type AccountStatus } from "../../hooks/useAccountStatus";

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

const TERM_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const VALUE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
};

const METER_TRACK_STYLE: CSSProperties = {
  height: 6,
  borderRadius: "var(--radius-1)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  overflow: "hidden",
};

const FROZEN_BADGE_STYLE: CSSProperties = {
  alignSelf: "flex-start",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "4px 10px",
};

/** Clamped fill ratio; guards a ceiling of 0 (unlimited never renders a meter). */
function fillRatio(used: number, ceiling: number): number {
  if (ceiling <= 0) return 0;
  return Math.max(0, Math.min(1, used / ceiling));
}

export function SyncUsageBlock({
  status,
  showStorage,
}: {
  status: AccountStatus;
  /**
   * Whether to render the STORAGE row and its meter. True only where the account
   * plane is known to be this person's own vault (myne-md/myne): on a member vault
   * the projection is the member's PERSON account, whose namespace holds none of
   * the shared vault's blobs, so the figure would read "0 B of 5 GB" above a vault
   * full of notes, which is true and misleading at once. The vault's real footprint
   * is the owner's account's business.
   *
   * The device row is always rendered, and is meaningful on both planes: it counts
   * the devices of whichever account this is and matches the roster above it.
   *
   * Required rather than defaulted, because the two callers know the plane and the
   * component does not: a `false` default would be right for the member and wrong
   * for the owner, and a `true` default would re-print the member's misleading
   * figure.
   */
  showStorage: boolean;
}) {
  const { t } = useTranslation();
  const storageUnlimited = isUnlimited(status.quota_bytes);
  const devicesUnlimited = isUnlimited(status.max_devices);
  const ratio = fillRatio(status.stored_bytes, status.quota_bytes);
  // A person account's figure is a SUM over several vaults (myne-md/myne#911
  // task 11), and the ceiling beside it is reported rather than enforced
  // (server-protocol §7.1). So this arm renders the total and what it spans, and
  // deliberately renders NO meter: a meter against a ceiling no vault is judged
  // against would claim an enforcement the server does not perform.
  const person = status.person === true;

  return (
    <div
      data-testid="sync.usage"
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
    >
      {showStorage && (
        <>
          <div style={ROW_STYLE} data-testid="sync.usage-storage">
            <span style={TERM_STYLE}>
              {person ? t("sync.usage.storageAcrossVaults") : t("sync.usage.storage")}
            </span>
            <span style={VALUE_STYLE}>
              {person || storageUnlimited
                ? formatBytes(status.stored_bytes)
                : t("sync.usage.ofTotal", {
                    used: formatBytes(status.stored_bytes),
                    total: formatBytes(status.quota_bytes),
                  })}
            </span>
          </div>

          {person && (
            <div
              style={TERM_STYLE}
              data-testid="sync.usage-vault-count"
            >
              {t("sync.usage.vaultCount", { count: status.vault_count ?? 0 })}
            </div>
          )}

          {/* Unlimited renders no meter — there is nothing to measure against. */}
          {!person && !storageUnlimited && (
            <div
              style={METER_TRACK_STYLE}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={status.quota_bytes}
              aria-valuenow={status.stored_bytes}
              aria-label={t("sync.usage.storage")}
              data-testid="sync.usage-meter"
            >
              <div
                style={{
                  width: `${ratio * 100}%`,
                  height: "100%",
                  background: "var(--accent)",
                }}
              />
            </div>
          )}
        </>
      )}

      <div style={ROW_STYLE} data-testid="sync.usage-devices">
        <span style={TERM_STYLE}>{t("sync.usage.devices")}</span>
        <span style={VALUE_STYLE}>
          {devicesUnlimited
            ? String(status.device_count)
            : t("sync.usage.ofTotal", {
                used: String(status.device_count),
                total: String(status.max_devices),
              })}
        </span>
      </div>

      {status.frozen && (
        <span style={FROZEN_BADGE_STYLE} data-testid="sync.usage-frozen">
          {t("sync.usage.frozen")}
        </span>
      )}
    </div>
  );
}
