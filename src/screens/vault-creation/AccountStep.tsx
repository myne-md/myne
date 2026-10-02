// Step 4 of 4 — account number display + acknowledgement + commit.
//
// Implements design session 2026-04-28-vault-creation-frontend.md:
//   - Q5.1 confirmation: checkbox-only — spec § 7.1.3 mandates phrase
//     confirmation but not account-number confirmation; account number's
//     loss is less catastrophic (vault still opens locally; only
//     Phase 2+ sync registration affected).
//   - Q5.2 display: large framed card + .t-account-number class + 24 px
//     font override; "shown only once" warning below the card with bold
//     danger-color emphasis.
//   - Q5.3 actions: Copy + Save-as-file with the same auto-clear / save
//     behavior as PhraseStep, but the save default name is
//     "myne-account-number.txt" and the content is the 27-char display
//     string.
//   - Q6.2 commit loading: inline disabled "Saving…" button with an
//     inline 14 px Spinner; no full-screen transition for sub-second
//     atomic write.
//   - Q7 error UX: inline banner above the card on COMMIT_ERR (mapped
//     by the orchestrator); SESSION_LOST routes to the dedicated screen.
//   - Q8.1 Back from AccountStep dispatches ACCOUNT_BACK → ConfirmStep.
//   - Q10 step indicator: STEP 4 OF 4 — ACCOUNT NUMBER.
//
// Spec: account-number.md § 7 (bearer-token semantics, "treat like cash").

import { useRef, type Dispatch } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Input } from "../../components/primitives/Input";
import { Spinner } from "../../components/Spinner";
import { ErrorBanner } from "../../components/ErrorBanner";
import {
  ActionStatus,
  type SecretAction,
  useActionStatus,
} from "../../components/ActionStatus";
import {
  copySecretToClipboard,
  saveOutcomeMessage,
  saveSecretAsTextFile,
} from "../../lib/secret-export";
import { StepEyebrow, StepHeading, StepLayout } from "./step-shell";
import type { Action, ErrorState } from "./reducer";

interface AccountStepProps {
  accountNumber: string;
  acknowledged: boolean;
  committing: boolean;
  error: ErrorState | null;
  /**
   * The shared invite code for a gated sync server (myne-md/myne#800). Empty for
   * an open server. The web client creates accounts, so a gated hosted server
   * refuses registration without it.
   */
  inviteCode: string;
  onInviteCodeChange: (value: string) => void;
  /** Render the invite-code field. True only where creation registers with a
   *  server (`REQUIRES_PROVISIONING`); a local-only vault has no gate to pass. */
  showInviteCode: boolean;
  dispatch: Dispatch<Action>;
}

export function AccountStep({
  accountNumber,
  acknowledged,
  committing,
  error,
  inviteCode,
  onInviteCodeChange,
  showInviteCode,
  dispatch,
}: AccountStepProps) {
  const { t } = useTranslation();
  // myne-md/myne#390: this used to be a bare `copied` flag reset only when the
  // step COMMITTED, so the label read "Copied" for the rest of the step no matter
  // what the user did next, a stale confirmation the user reads as the result of
  // the tap they just made. The shared hook reverts on its own and carries the
  // live region, so a screen reader hears the outcome too.
  const { outcome, flashing, feedbackFor } = useActionStatus<SecretAction>();
  // The button LABEL uses the momentary half, so it reverts; the status line
  // below uses the persistent half, so the outcome stays readable.
  const copied = flashing && outcome?.action === "copy" && outcome.ok;

  // NO unmount cancel, and the omission is the point, matching PhraseStep.
  //
  // Cancelling on unmount looks like hygiene and is the opposite: advancing off
  // this step is the INTENDED next action, so the cancel fired on the normal
  // path and left the account number on the system clipboard indefinitely,
  // while the line above it had just promised a 30 s clear. The heap argument
  // that motivated it is also gone: `copySecret` releases the value on both
  // exits, so what a pending timer holds is a reference in a process that
  // already has the account number in React state.
  //
  // Letting it fire after unmount is safe for the same reason it is on the
  // phrase step: the clear is the host-side compare-and-clear, so it wipes the
  // clipboard only if the account number is still on it, and a user who copied
  // something else in the window keeps what they copied.
  const cancelAutoClearRef = useRef<(() => void) | null>(null);

  const handleCopy = async () => {
    cancelAutoClearRef.current?.();
    // A once-only, secret-bearing surface, so both arms are INLINE rather than
    // toasts: the confirmation belongs next to the button the user just pressed,
    // and a transient toast on a screen shown once is the weakest affordance
    // available. `vaultCreation.account.copyFailed` finally has a desktop
    // consumer, it has existed in all 32 catalogs since it was written, with its
    // only caller on the mobile client, because this branch was checked here and
    // then dropped.
    const cancel = await copySecretToClipboard(accountNumber, feedbackFor("copy"));
    cancelAutoClearRef.current = cancel;
  };

  const handleSave = () =>
    saveSecretAsTextFile("myne-account-number.txt", accountNumber, feedbackFor("save"));

  // Exhaustive over `SecretAction` by construction, so a third affordance is a
  // compile error here rather than a silent fall into the save sentence. The
  // keys stay STATIC `t("…")` literals inside the arms: `check-i18n.mjs` reads
  // them by scanning for exactly that shape, and a table of key strings would
  // put four load-bearing keys outside everything that checks them.
  const message: Record<SecretAction, (ok: boolean) => string> = {
    copy: (ok) =>
      ok ? t("vaultCreation.account.copied") : t("vaultCreation.account.copyFailed"),
    // The success half branches on the capability for the same reason the phrase
    // step's copy half does: a client may not claim a guarantee it cannot make.
    // `saveOutcomeMessage` holds that decision for both screens; the `t("…")`
    // literals stay here, where `check-i18n.mjs` can see them.
    save: (ok) =>
      saveOutcomeMessage(ok, {
        saved: t("vaultCreation.account.savedToFile"),
        started: t("vaultCreation.account.downloadStarted"),
        failed: t("vaultCreation.account.saveFailed"),
      }),
  };

  return (
    <StepLayout width={480}>
      <StepEyebrow icon="id-card">{t("vaultCreation.account.eyebrow")}</StepEyebrow>
      <StepHeading>{t("vaultCreation.account.heading")}</StepHeading>

      <div style={{ fontSize: "var(--text-base)", lineHeight: 1.6, color: "var(--fg-2)" }}>
        {t("vaultCreation.account.intro")}
      </div>

      {error && error.displayMode === "inline" && (
        <ErrorBanner error={error} />
      )}

      <div
        style={{
          padding: "var(--space-5)",
          background: "var(--paper-2)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-2)",
          textAlign: "center",
        }}
      >
        <span
          className="t-account-number"
          style={{ fontSize: 24 }}
          data-testid="create.account-number"
        >
          {accountNumber}
        </span>
      </div>

      <div style={{ fontSize: "var(--text-sm)", lineHeight: 1.6, color: "var(--fg-2)" }}>
        <strong style={{ color: "var(--danger)" }}>
          {t("vaultCreation.account.shownOnceEmphasis")}
        </strong>{" "}
        {t("vaultCreation.account.shownOnceBody")}
      </div>

      {/* The invite code for a gated sync server. Optional: an open server
          (self-host) needs none, and this client persists it device-locally,
          never syncing it. Rendered only where creation registers with a server,
          because the WEB client creates accounts and has no sync-settings panel
          before the vault exists. */}
      {showInviteCode && (
        <>
          <label
            htmlFor="create-invite-code"
            style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}
          >
            {t("sync.endpoint.inviteLabel")}
          </label>
          <Input
            id="create-invite-code"
            mono
            value={inviteCode}
            onChange={(e) => onInviteCodeChange(e.target.value)}
            placeholder={t("sync.endpoint.invitePlaceholder")}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            data-testid="create.invite-code"
          />
        </>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Button variant="ghost" icon="copy" onClick={handleCopy}>
          {copied ? t("vaultCreation.account.copied") : t("vaultCreation.account.copy")}
        </Button>
        <Button
          variant="ghost"
          icon="download"
          onClick={handleSave}
          data-testid="create.account-save"
        >
          {t("vaultCreation.account.saveAsFile")}
        </Button>
      </div>

      {/* The failure line, and the announcement for BOTH outcomes. The success
          case is already visible as the button's label swap, so it is announced
          without being drawn twice; the failure case has no other surface, so it
          renders. */}
      <ActionStatus
        testId="create.account-action-status"
        // Only the COPY success is drawn twice by the button's own label swap,
        // so only that one is hidden. A save has no label to swap, so both of its
        // outcomes render.
        visuallyHidden={outcome?.action === "copy" && outcome.ok}
        message={outcome === null ? null : message[outcome.action](outcome.ok)}
      />

      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: 12,
          background: "var(--paper-2)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-2)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) =>
            dispatch({ type: "ACCOUNT_ACK_TOGGLED", checked: e.target.checked })
          }
          style={{ marginTop: 3, accentColor: "var(--accent)" }}
          data-testid="create.account-ack"
        />
        <div style={{ fontSize: "var(--text-sm)", lineHeight: 1.5, color: "var(--fg-1)" }}>
          {t("vaultCreation.account.ackLabel")}
        </div>
      </label>

      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        <Button
          variant="ghost"
          onClick={() => dispatch({ type: "ACCOUNT_BACK" })}
          icon="arrow-left"
          disabled={committing}
          data-testid="create.account-back"
        >
          {t("vaultCreation.account.back")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button
          variant="primary"
          onClick={() => dispatch({ type: "COMMIT_REQUESTED" })}
          disabled={!acknowledged || committing}
          data-testid="create.account-commit"
        >
          {committing && (
            <Spinner
              size={14}
              style={{
                border: "2px solid rgba(255,255,255,0.4)",
                borderTopColor: "var(--accent-on)",
              }}
            />
          )}
          {committing
            ? t("vaultCreation.account.committing")
            : t("vaultCreation.account.commit")}
        </Button>
      </div>
    </StepLayout>
  );
}
