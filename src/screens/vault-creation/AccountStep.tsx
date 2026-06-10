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
      <StepEyebrow icon="id-card">Step 4 of 4 — account number</StepEyebrow>
      <StepHeading>Save your account number.</StepHeading>

      <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--fg-2)" }}>
        This is your bearer token — treat it like cash.
      </div>

      {error && error.displayMode === "inline" && (
        <ErrorBanner error={error} />
      )}

      <div
        style={{
          padding: 24,
          background: "var(--paper-2)",
          border: "1px solid var(--line-1)",
          borderRadius: 6,
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

      <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--fg-2)" }}>
        <strong style={{ color: "var(--danger)" }}>
          This is shown only once.
        </strong>{" "}
        Save it now — Myne cannot recover it for you. Required to register for
        sync later.
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="ghost" icon="copy" onClick={handleCopy}>
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="ghost" icon="download" onClick={handleSave}>
          Save as file
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
          borderRadius: 6,
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
        <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--fg-1)" }}>
          I have saved my account number where I can find it later.
        </div>
      </label>

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <Button
          variant="ghost"
          onClick={() => dispatch({ type: "ACCOUNT_BACK" })}
          icon="arrow-left"
          disabled={committing}
          data-testid="create.account-back"
        >
          Back
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
          {committing ? "Saving…" : "Create vault"}
        </Button>
      </div>
    </StepLayout>
  );
}
