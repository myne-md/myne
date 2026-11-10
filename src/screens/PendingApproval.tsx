// The web client's approval wait (MYND-635): the screen a browser sits on
// between enrolling and being let in.
//
// # Why it is a screen and not a step
//
// A browser enrols through the invite flow, and `server-protocol.md` §3.1 makes
// that land **pending** until an existing device approves. There is no
// self-approving arm here, because a page cannot hold the recovery phrase, so
// "pending" is the normal outcome rather than an edge case, and it survives a
// refresh: boot routing sends a device whose probe says awaiting-approval to
// the `pending-approval` stage, which renders this.
//
// # Why the account form it used to sit beside is gone
//
// This screen shared a file with the web's account-number + password sign-in
// (`AccountBootstrap`). Joining a vault now means joining a PERSON: the account
// number is not a door on any client (`decisions/sync/0767`), so the form, its
// number entry and its password step are deleted and what remains is the wait.
//
// # What it owes the user
//
// The comparison, not a spinner. `docs/threat-model.md` §7 names the vault-head
// fingerprint eye-compare as the only mitigation for a server seating a device
// onto a forked history, and a browser carries a LARGER share of that assurance
// than desktop does: it has neither certificate pinning nor channel binding
// (`sync-protocol.md` §8.4). The hook polls `sync_now` until a head is adopted
// and then reports that head's fingerprint, so the code on this screen and the
// code on the approving device are the same number.

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../platform/core";
import { resetLocalOrReport } from "../lib/reset-local";
import { Button } from "../components/primitives/Button";
import { CenteredCard } from "../components/primitives/CenteredCard";
import { DestructiveBanner } from "../components/DestructiveBanner";
import { useHeadFingerprintCompare } from "../hooks/useHeadFingerprintCompare";
import { ENROLL_PENDING_NOTICE } from "../lib/load-bearing-copy";

const HINT_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
};

const SAS_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-2xl)",
  fontWeight: "var(--weight-bold)",
  letterSpacing: "0.16em",
  textAlign: "center",
  padding: "var(--space-4)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
};

const APPROVER_LIST_STYLE: CSSProperties = {
  color: "var(--fg-2)",
  fontSize: "var(--text-sm)",
  margin: "var(--space-1) 0",
  paddingInlineStart: "var(--space-5)",
};

export interface PendingApprovalProps {
  /**
   * The wait is over, one way or the other: an approval landed, or the user
   * reset this device back to nothing. The caller re-enters through the boot
   * probe rather than being handed a stage, the same door restore-backup and
   * back-from-create use, so boot routing stays the one place that decides what
   * a container means.
   */
  onSettled: () => void;
}

export function PendingApproval({ onSettled }: PendingApprovalProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);
  /** Who can approve, named up front rather than discovered at a spinner. */
  const [approvers, setApprovers] = useState<string[] | null>(null);

  const { fingerprint: sas, changed: sasChanged } = useHeadFingerprintCompare(true, "joiner");

  // A device that is still pending cannot read the roster for itself, so this
  // is best-effort and its FAILURE is meaningful: `null` renders neither list
  // nor "nobody can", because saying "nobody can approve you" on the strength
  // of a failed call would be worse than saying nothing.
  useEffect(() => {
    let cancelled = false;
    void invoke<Array<{ name?: string | null; device_id_hex?: string; approved?: boolean }>>(
      "plugin:sync|sync_list_devices",
    )
      .then((rows) => {
        if (cancelled) return;
        setApprovers(
          rows
            .filter((r) => r.approved === true)
            .map((r) => r.name?.trim() || (r.device_id_hex ?? "").slice(0, 8)),
        );
      })
      .catch(() => {
        /* leave `null`: unknown is not "nobody" */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // One handler for both escapes, and it is the same call rather than a copy of
  // it (`lib/reset-local.ts`). A FAILED un-enrol must not clear the screen: a
  // refusal leaves the enrolment in place, so a screen that reset anyway would
  // tell the user they had left and bring them back on the next reload.
  const reset = () => {
    setAborting(true);
    setError(null);
    void resetLocalOrReport().then((done) => {
      setAborting(false);
      if (!done) {
        setError(t("sync.join.sasAbortFailed"));
        return;
      }
      onSettled();
    });
  };

  if (sas !== null) {
    return (
      <CenteredCard>
        <h1 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xl)" }}>
          {t("approvalWait.verifyTitle")}
        </h1>
        <p style={HINT_STYLE}>{t("approvalWait.verifyBody")}</p>
        <div style={SAS_STYLE} data-testid="pending-approval.sas">
          {sas}
        </div>
        {/* The head moved mid-compare. Said out loud, so a changed code is a
            prompt to look again rather than a silent re-convergence. */}
        {sasChanged && (
          <p style={HINT_STYLE} data-testid="pending-approval.sas-changed">
            {t("common.thecodechangedwhileyouwerelookingcomparebothscreensagainifitkeepschangingstopanddonotcontinue")}
          </p>
        )}
        {/* The abort's own failure surfaces HERE, in the step where the user
            pressed it, not as a cleared screen that implies it worked. */}
        {error && <DestructiveBanner testId="pending-approval.error">{error}</DestructiveBanner>}
        <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-2)" }}>
          <Button
            variant="ghost"
            data-testid="pending-approval.sas-mismatch"
            type="button"
            disabled={aborting}
            onClick={reset}
          >
            {t("approvalWait.sasMismatch")}
          </Button>
          <Button
            variant="primary"
            data-testid="pending-approval.sas-match"
            type="button"
            disabled={aborting}
            onClick={onSettled}
          >
            {t("approvalWait.sasMatch")}
          </Button>
        </div>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard>
      <h1 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xl)" }}>
        {t("common.waitingforapproval")}
      </h1>
      {/* Load-bearing copy: rendered verbatim, never translated (SYNC-13 /
          `src/lib/load-bearing-copy.ts`). It states what approval does and does
          not mean, and a paraphrase would weaken it. */}
      <p style={HINT_STYLE} data-testid="pending-approval.pending-notice">
        {ENROLL_PENDING_NOTICE}
      </p>
      {approvers !== null && approvers.length > 0 && (
        <>
          <p style={HINT_STYLE} data-testid="pending-approval.approvers-intro">
            {t("approvalWait.approversIntro")}
          </p>
          <ul style={APPROVER_LIST_STYLE} data-testid="pending-approval.approvers">
            {approvers.map((name, i) => (
              <li key={`${name}-${i}`}>{name}</li>
            ))}
          </ul>
        </>
      )}
      {approvers !== null && approvers.length === 0 && (
        // The situation worth saying out loud: nothing on the account can
        // approve this browser. A spinner here would wait forever without ever
        // explaining why.
        <p style={HINT_STYLE} data-testid="pending-approval.no-approvers">
          {t("approvalWait.noApprovers")}
        </p>
      )}
      {error !== null && <DestructiveBanner testId="pending-approval.error">{error}</DestructiveBanner>}

      {/* #269: the way out. Boot re-enters this stage on every reload, so a
          device that enrolled against the WRONG account, or one whose approver
          is gone, had no route back at all. */}
      <Button
        variant="ghost"
        data-testid="pending-approval.pending-reset"
        type="button"
        disabled={aborting}
        style={{ marginTop: "var(--space-3)" }}
        onClick={reset}
      >
        {t("approvalWait.pendingStartOver")}
      </Button>
    </CenteredCard>
  );
}
