// The approval wait: one implementation of "has an approval landed", used by the
// `pending-approval` stage and by a join that has just installed a vault.
//
// It is the ONLY join surface left on this client. The account-number door
// (`sync_join_account`, a password or a 24-word phrase typed into a form) is gone
// everywhere as of `decisions/sync/0767`: joining a vault means joining a person,
// and a person's vault arrives by invite, not by an account number. So this flow
// no longer collects a credential, scans a QR or writes `vault.meta` — the
// identity flow does that, and this screen is what it hands off to.
//
// What the screen owns is the ceremony the whole feature exists for: poll until
// this device has pulled and MAC-verified a head, then show the 8-character
// Crockford fingerprint (§6.3 / SYNC-17) for the eye-compare against the device
// that approved it. Two things are load-bearing and neither is decoration:
//
//   - The poll fires `sync_now`, which is what CLAIMS the per-device token once
//     the other device has approved. A device sitting on this screen is the only
//     thing that turns an approval into a pull, so the approving device's own
//     screen ("this code appears once the new device finishes its first sync")
//     cannot resolve without it.
//   - A mismatch ABORTS the join: `sync_reset_local` un-enrols this device so it
//     stops trusting possibly forked data. Closing the screen IS the claim that it
//     worked, so a failed abort must not be swallowed (`docs/decisions/ui/0482`).
//
// The vault is UNLOCKED on this screen, deliberately: the token claim needs
// `root_key`. That is why the idle auto-lock is armed here, the one post-unlock
// screen that is not the editor.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Screen, Title, FooterBar, Button, Banner } from "../../components";
import { syncResetLocal } from "../../lib/sync";
import { useHeadFingerprintCompare } from "../../hooks/useHeadFingerprintCompare";
import { usePrefs } from "../../lib/use-prefs";
import { useIdleAutoLock } from "../../hooks/useIdleAutoLock";
import { HAS_TAURI } from "../../lib/app-window";
import { clearApprovalWait } from "@myne/client-core/approval-wait";
import { ENROLL_PENDING_NOTICE } from "../../lib/load-bearing-copy";
import type { VaultId } from "../../lib/stage";

export interface ApprovalWaitFlowProps {
  /** The vault being waited on. Threaded from the join that installed it, so the
   *  marker can be retired by id and `onApproved` can address the editor it
   *  returns to. `undefined` on the boot-probe editor entry, for the same reason
   *  that stage's own field is. */
  vaultId?: VaultId;
  onApproved: (vaultId?: VaultId) => void;
  onCancel: () => void;
}

export function ApprovalWaitFlow({ vaultId, onApproved, onCancel }: ApprovalWaitFlowProps) {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const [step, setStep] = useState<"pending" | "verify">("pending");
  const [aborting, setAborting] = useState(false);
  /** The un-enrol failed — the device is STILL enrolled, and the screen must say
   *  so instead of closing (`docs/decisions/ui/0482`). */
  const [abortFailed, setAbortFailed] = useState(false);

  /**
   * The one exit that decides the marker, and the rule is one sentence: leaving
   * retires it once the code has been SHOWN, and keeps it otherwise.
   *
   * Both halves are load-bearing, and they came from two reviewers pulling in
   * opposite directions. Retiring the marker on arrival at this screen makes the
   * only out-of-band compare in the product optional, and `threat-model.md` §7 keeps
   * a phone's wait across a relaunch precisely so it does not become optional. Not
   * retiring it at all leaves a marker that no path can clear: a user who presses
   * Cancel could then only leave by answering a compare, and the reject answer is a
   * local un-enrol.
   *
   * With the rule below the compare has been OFFERED before the marker goes (the code
   * was on screen, so `step === "verify"`), and nothing is skipped. A user who leaves
   * before that keeps the marker and meets the wait again on the next unlock, which is
   * the behaviour §7 describes, and that screen's own approval poll is what turns the
   * wait into a code.
   *
   * A `useCallback` rather than a plain function because `useIdleAutoLock` names it in
   * an effect dependency: a fresh identity per render would tear the timer down and
   * re-arm it, and the list behind this screen re-renders about once a second.
   */
  const leave = useCallback(() => {
    if (vaultId !== undefined && step === "verify") clearApprovalWait(vaultId);
    onCancel();
  }, [vaultId, step, onCancel]);

  // Idle re-lock for the one post-unlock screen that is not the editor. It locks
  // and then re-probes, which lands on the unlock form for this vault, the same
  // destination `leave` chooses, because a locked vault is a locked vault whoever
  // asked.
  //
  // Both exits go through `leave`, which is the one place that decides whether the
  // marker that owes this compare is retired. See its comment.
  useIdleAutoLock(leave, prefs.auto_lock_seconds);

  // Armed for both steps: the head can arrive while the spinner is up (that is
  // the ordinary case) and it must keep being watched once the compare is
  // showing, because a head that moves under the reader is a guess rather than a
  // comparison.
  const { fingerprint, changed: sasChanged } = useHeadFingerprintCompare(HAS_TAURI, "joiner");

  // A non-null fingerprint means this device pulled and MAC-verified a head, i.e.
  // the approval landed. Never held back on purpose: nothing may sit in front of
  // the match code (MYND-537).
  useEffect(() => {
    if (fingerprint !== null) setStep("verify");
  }, [fingerprint]);

  // SAS mismatch → ABORT the join: un-enrol this device so it stops trusting the
  // (possibly forked) synced data, then back out. Stay put if the abort failed:
  // the device is still enrolled, and a screen that closed would have told the
  // user it was not.
  async function onMismatch() {
    setAborting(true);
    setAbortFailed(false);
    try {
      if (HAS_TAURI) await syncResetLocal();
    } catch {
      setAborting(false);
      setAbortFailed(true);
      return;
    }
    // The join is abandoned, so the marker has nothing left to ask for. The
    // un-enrol above already cleared the enrolment, and this clears the question
    // that pointed at it.
    if (vaultId !== undefined) clearApprovalWait(vaultId);
    onCancel();
  }

  if (step === "pending") {
    return (
      <Screen style={{ alignItems: "center", justifyContent: "center", padding: "0 32px" }}>
        <div
          data-testid="sync.join.pending"
          style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}
        >
          <svg
            className="myne-spinner"
            width="56"
            height="56"
            viewBox="0 0 56 56"
            fill="none"
            style={{ marginBottom: 22 }}
          >
            <circle cx="28" cy="28" r="24" stroke="var(--line-1)" strokeWidth="2" />
            <path d="M28 4a24 24 0 0 1 24 24" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          <Title>{t("sync.join.waitingTitle")}</Title>
          <div
            style={{ marginTop: 12, fontSize: 15, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 320 }}
          >
            {ENROLL_PENDING_NOTICE}
          </div>
          <div
            style={{ marginTop: 14, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)", maxWidth: 320 }}
          >
            {t("join.waitingHint")}
          </div>
        </div>
        {/* Cancel leaves the wait. What that means is the CALLER's answer: the
            stage locks the vault and re-probes, because this screen has no
            overlay underneath to close back to. `leave` also decides the marker,
            and on this arm nothing has been presented yet, so it keeps it. */}
        <FooterBar style={{ padding: "14px 20px calc(14px + env(safe-area-inset-bottom, 0px))", borderTop: "none" }}>
          <Button variant="ghost" onClick={leave} data-testid="sync.join.cancel">
            {t("common.prompt.cancel")}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  return (
    <Screen style={{ alignItems: "center", justifyContent: "center", padding: "0 32px" }}>
      <div
        data-testid="sync.join.verify"
        style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}
      >
        <Title>{t("sync.join.verifyTitle")}</Title>
        <div style={{ marginTop: 12, fontSize: 15, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 320 }}>
          {t("join.verifyBody")}
        </div>
        <div
          style={{
            marginTop: 24,
            fontFamily: "var(--font-mono)",
            fontSize: 34,
            fontWeight: 700,
            letterSpacing: "0.16em",
            color: "var(--fg-1)",
            padding: "18px 26px",
            background: "var(--paper-2)",
            border: "1px solid var(--line-1)",
            borderRadius: 12,
          }}
          data-testid="sync.join.sas-fingerprint"
        >
          {fingerprint}
        </div>
        {/* The head moved while the compare was open. Announced, not swapped
            silently: a code that changes under the reader is a guess, not a
            comparison. */}
        {sasChanged && (
          <div
            style={{
              marginTop: "var(--space-4)",
              fontSize: "var(--text-sm)",
              lineHeight: "var(--leading-relaxed)",
              color: "var(--fg-2)",
              maxWidth: 320,
            }}
            data-testid="sync.join.sas-changed"
          >
            {t("join.verifyChanged")}
          </div>
        )}
        {abortFailed && (
          <div style={{ marginTop: "var(--space-4)", maxWidth: 320 }} data-testid="sync.join.sas-abort-failed">
            <Banner kind="danger">{t("sync.join.sasAbortFailed")}</Banner>
          </div>
        )}
      </div>
      <FooterBar
        style={{
          padding: "14px 20px calc(14px + env(safe-area-inset-bottom, 0px))",
          borderTop: "none",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <Button
          disabled={aborting}
          onClick={() => {
            // The compare just matched, so the approval this device was waiting
            // for has been OBSERVED: retiring the marker here is what stops every
            // later unlock from routing back to this screen.
            if (vaultId !== undefined) clearApprovalWait(vaultId);
            onApproved(vaultId);
          }}
          data-testid="sync.join.sas-match"
        >
          {t("sync.join.sasMatch")}
        </Button>
        <Button
          variant="ghost"
          disabled={aborting}
          onClick={() => void onMismatch()}
          style={{ color: "var(--danger)" }}
          data-testid="sync.join.sas-mismatch"
        >
          {aborting ? t("join.removing") : t("join.sasMismatch")}
        </Button>
      </FooterBar>
    </Screen>
  );
}
