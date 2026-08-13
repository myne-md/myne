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

import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { has } from "../platform/capabilities";
import { collectDiagnostics } from "../lib/collect-diagnostics";
import type { TFunction } from "i18next";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
  ctaHover,
  ctaStyle,
} from "./primitives/CenteredCard";
import { hoverSurface } from "./primitives/hoverSurface";
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
  /**
   * i18n key overriding the primary CTA's label (phase3-web-client task 95).
   *
   * Passed ONLY by the call sites whose CTA is the platform EXIT — where the
   * label has to match a behaviour that differs per platform (desktop destroys
   * the window, web reloads the page), so it comes from the same seam module as
   * the action and the two cannot drift.
   *
   * Absent everywhere else, and that is load-bearing rather than tidy: the
   * Editor mount guard's `invalid-state` CTA is a LOCK, not an exit, and its
   * label is the reason's own copy. An earlier version of this change made the
   * seam label unconditional and turned that button into "Close Myne" — a
   * button that lied about what it did, on the one screen where the user is
   * most stuck.
   */
  ctaLabelKey?: string;
  /**
   * A BOUNDED failure label from the closed diagnostic set (phase3-web-client
   * task 114) — never a message string.
   *
   * The rule this file has always carried is "NO diagnostic detail in prod
   * (TB6 — keep the internal state model off the wire)". This narrows it to "no
   * *unbounded* detail" and does not reverse it: a code says what CLASS of thing
   * broke, which is what a maintainer can act on, while a thrown `Error`'s
   * message is arbitrary text from arbitrary code and on this client can quote a
   * path, a note title, or a credential the throwing call had in scope.
   *
   * When present, a "Copy diagnostics" affordance appears. It copies an
   * allowlist-built block (`src/lib/diagnostics.ts`) and transmits nothing —
   * there is no reporting endpoint and no beacon.
   */
  code?: string;
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

/** The shared card CTA, sized to its label rather than to the card. See the
 *  note on the identical constant in `StorageLost.tsx`. */
const CTA_STYLE: CSSProperties = {
  ...ctaStyle(false),
  marginTop: "var(--space-2)",
  alignSelf: "flex-start",
};

const SECONDARY_CTA_STYLE: CSSProperties = {
  ...CTA_STYLE,
  background: "transparent",
  color: "var(--fg-2)",
  border: "1px solid var(--line-1)",
};

/** The secondary's own hover — the canon surface deepen, not the accent ramp.
 *  `ctaHover` would restore `--accent` on pointer-leave and repaint a
 *  transparent button solid blue. */
const secondaryHover = () =>
  hoverSurface({ restBg: "transparent", hoverBg: "var(--bg-3)" });

export function FailClosedError({
  reason,
  onCtaClick,
  onRestoreBackup,
  ctaLabelKey,
  code,
}: FailClosedErrorProps) {
  const { t } = useTranslation();
  const copy = copyForReason(reason, t);
  const [copied, setCopied] = useState(false);
  // The restore door is offered only where BACKUP EXISTS (phase3-web-client
  // task 70). Boot routing already keeps a web client away from the
  // `corrupted-vault` surface (`initialStageFromProbe` sends it to
  // `account-entry` when `backup` is absent), but the OTHER door into this
  // screen is a runtime one: an `InvalidVaultMeta` mid-unlock switches the
  // Unlock component to `corrupted-after-unlock` regardless of platform. That
  // path would have rendered "Restore from a backup" on a client whose every
  // `backup_*` command answers `Unsupported` — an offer the platform cannot
  // honour, which is exactly what `decisions.md` 2026-07-26's "absent, not
  // disabled" rule forbids.
  const restoreDoor =
    reason.kind === "corrupted-vault" && has("backup") ? onRestoreBackup : undefined;
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
            {...ctaHover(false)}
            data-testid="fail-closed.restore-cta"
          >
            {t("failClosed.restoreFromBackup")}
          </button>
        )}
        <button
          type="button"
          onClick={onCtaClick}
          style={restoreDoor !== undefined ? SECONDARY_CTA_STYLE : CTA_STYLE}
          {...(restoreDoor !== undefined ? secondaryHover() : ctaHover(false))}
          data-testid="fail-closed.cta"
        >
          {ctaLabelKey ? t(ctaLabelKey) : copy.cta}
        </button>
        {code !== undefined && (
          <button
            type="button"
            style={SECONDARY_CTA_STYLE}
            {...secondaryHover()}
            data-testid="fail-closed.copy-diagnostics"
            data-code={code}
            onClick={() => {
              void collectDiagnostics(code)
                .then((text) => navigator.clipboard.writeText(text))
                .then(() => setCopied(true))
                .catch(() => {
                  // A refused clipboard is a browser permission decision, not a
                  // failure worth a second error surface on the screen where the
                  // user is already stuck. The code is on the button's own
                  // `data-code`, so it is still readable.
                });
            }}
          >
            {copied ? t("failClosed.diagnosticsCopied") : t("failClosed.copyDiagnostics")}
          </button>
        )}
      </div>
    </CenteredCard>
  );
}
