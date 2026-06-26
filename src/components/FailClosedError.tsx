// Shared fail-closed error UI — task 4 of `app-state-machine`.
//
// Three reasons, three CTA semantics:
//
// - `corrupted-vault`: vault.meta exists but failed `parse_vault_meta`
//   (magic / length / kdf_id / reserved-byte mismatch) at boot OR a
//   unlock attempt returned `InvalidVaultMeta`. CTA "Uygulamayı kapat"
//   only — NO welcome / unlock fallback (would risk a destructive
//   overwrite path; see `app-state-machine` PRD Q8(a)).
// - `io-error`: filesystem failure reading vault.meta (PermissionDenied,
//   NoSpace, Other). Same fail-closed UI, message varies by io_kind.
// - `invalid-state`: React state ↔ Rust slot disagreement detected at
//   component-mount reality check (Q5β-1 belt+suspenders). CTA
//   "Lock" — calls `vault_lock` (idempotent, even on empty slot)
//   then re-probes via `vault_status` and routes accordingly.
//
// NO diagnostic detail in prod (TB6: keep internal state model off
// the wire). SINGLE CTA per render — fail-closed contract.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
} from "./primitives/CenteredCard";
import type { IoFailureKind } from "../lib/stage";

export type FailClosedReason =
  | { kind: "corrupted-vault" }
  | { kind: "io-error"; ioKind: IoFailureKind }
  | { kind: "invalid-state" };

interface FailClosedErrorProps {
  reason: FailClosedReason;
  onCtaClick: () => void;
  /**
   * Corrupted-vault repair door (MYND-56; decisions.md 2026-06-10
   * superseding entry — the single-CTA fail-closed posture predates a
   * real restore route). When present on `corrupted-vault`, renders as
   * the PRIMARY action; the original CTA ("Close app") demotes to
   * secondary. Other reasons ignore it.
   */
  onRestoreBackup?: () => void;
}

interface ReasonCopy {
  title: string;
  body: string;
  cta: string;
}

function copyForReason(reason: FailClosedReason, t: TFunction): ReasonCopy {
  switch (reason.kind) {
    case "corrupted-vault":
      return {
        title: t("failClosed.corrupted.title"),
        body: t("failClosed.corrupted.body"),
        cta: t("failClosed.corrupted.cta"),
      };
    case "io-error":
      return reason.ioKind === "PermissionDenied"
        ? {
            title: t("failClosed.permissionDenied.title"),
            body: t("failClosed.permissionDenied.body"),
            cta: t("failClosed.permissionDenied.cta"),
          }
        : {
            title: t("failClosed.ioError.title"),
            body: t("failClosed.ioError.body"),
            cta: t("failClosed.ioError.cta"),
          };
    case "invalid-state":
      return {
        title: t("failClosed.invalidState.title"),
        body: t("failClosed.invalidState.body"),
        cta: t("failClosed.invalidState.cta"),
      };
  }
}

const CTA_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  alignSelf: "flex-start",
  background: "var(--accent)",
  color: "var(--accent-on)",
  border: "none",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  cursor: "pointer",
};

const SECONDARY_CTA_STYLE: CSSProperties = {
  ...CTA_STYLE,
  background: "transparent",
  color: "var(--fg-2)",
  border: "1px solid var(--line-1)",
};

export function FailClosedError({
  reason,
  onCtaClick,
  onRestoreBackup,
}: FailClosedErrorProps) {
  const { t } = useTranslation();
  const copy = copyForReason(reason, t);
  const restoreDoor =
    reason.kind === "corrupted-vault" ? onRestoreBackup : undefined;
  return (
    <CenteredCard>
      <div
        role="alert"
        aria-live="assertive"
        data-testid="fail-closed.root"
        data-reason={reason.kind}
        style={{ display: "contents" }}
      >
        <h1 style={CARD_TITLE_STYLE} data-testid="fail-closed.title">
          {copy.title}
        </h1>
        <p style={CARD_BODY_STYLE}>{copy.body}</p>
        {restoreDoor !== undefined && (
          <button
            type="button"
            onClick={restoreDoor}
            style={CTA_STYLE}
            data-testid="fail-closed.restore-cta"
          >
            {t("failClosed.restoreFromBackup")}
          </button>
        )}
        <button
          type="button"
          onClick={onCtaClick}
          style={restoreDoor !== undefined ? SECONDARY_CTA_STYLE : CTA_STYLE}
          data-testid="fail-closed.cta"
        >
          {copy.cta}
        </button>
      </div>
    </CenteredCard>
  );
}
