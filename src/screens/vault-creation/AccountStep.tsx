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

import { useEffect, useRef, useState, type Dispatch } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Spinner } from "../../components/Spinner";
import { ErrorBanner } from "../../components/ErrorBanner";
import {
  copySecretToClipboard,
  saveSecretAsTextFile,
} from "../../lib/secret-export";
import { StepEyebrow, StepHeading, StepLayout } from "./step-shell";
import type { Action, ErrorState } from "./reducer";

interface AccountStepProps {
  accountNumber: string;
  acknowledged: boolean;
  committing: boolean;
  error: ErrorState | null;
  dispatch: Dispatch<Action>;
}

export function AccountStep({
  accountNumber,
  acknowledged,
  committing,
  error,
  dispatch,
}: AccountStepProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (committing) setCopied(false);
  }, [committing]);

  // Cancel any pending clipboard auto-clear on unmount so the timer's
  // closure (which captures the bearer-token account number) is released.
  const cancelAutoClearRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      cancelAutoClearRef.current?.();
    },
    [],
  );

  const handleCopy = async () => {
    cancelAutoClearRef.current?.();
    const cancel = await copySecretToClipboard(accountNumber);
    cancelAutoClearRef.current = cancel;
    if (cancel) setCopied(true);
  };

  const handleSave = () =>
    saveSecretAsTextFile("myne-account-number.txt", accountNumber);

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

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Button variant="ghost" icon="copy" onClick={handleCopy}>
          {copied ? t("vaultCreation.account.copied") : t("vaultCreation.account.copy")}
        </Button>
        <Button variant="ghost" icon="download" onClick={handleSave}>
          {t("vaultCreation.account.saveAsFile")}
        </Button>
      </div>

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
