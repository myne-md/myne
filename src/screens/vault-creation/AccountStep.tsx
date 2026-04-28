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

import { useEffect, useState, type Dispatch } from "react";
import {
  writeText as clipboardWriteText,
  readText as clipboardReadText,
  clear as clipboardClear,
} from "@tauri-apps/plugin-clipboard-manager";
import { save as dialogSave } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { Button } from "../../components/primitives/Button";
import { Spinner } from "../../components/Spinner";
import { ErrorBanner } from "../../components/ErrorBanner";
import { logErrorKind } from "../../lib/vault-creation-logging";
import { StepEyebrow, StepHeading, StepLayout } from "./step-shell";
import type { Action, ErrorState } from "./reducer";

interface AccountStepProps {
  accountNumber: string;
  acknowledged: boolean;
  committing: boolean;
  error: ErrorState | null;
  dispatch: Dispatch<Action>;
}

const CLIPBOARD_AUTO_CLEAR_MS = 30_000;

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

  const handleCopy = async () => {
    try {
      await clipboardWriteText(accountNumber);
      setCopied(true);
    } catch (e) {
      logErrorKind(e, "clipboard-write-failed");
      return;
    }
    setTimeout(async () => {
      try {
        const current = await clipboardReadText();
        if (current === accountNumber) {
          await clipboardClear();
        }
      } catch (e) {
        logErrorKind(e, "clipboard-auto-clear-failed");
      }
    }, CLIPBOARD_AUTO_CLEAR_MS);
  };

  const handleSave = async () => {
    let path: string | null;
    try {
      path = await dialogSave({
        defaultPath: "myne-account-number.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
    } catch (e) {
      logErrorKind(e, "dialog-save-failed");
      return;
    }
    if (!path) return;
    try {
      await writeTextFile(path, accountNumber);
    } catch (e) {
      logErrorKind(e, "fs-write-failed");
    }
  };

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
        <span className="t-account-number" style={{ fontSize: 24 }}>
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
        >
          Back
        </Button>
        <div style={{ flex: 1 }} />
        <Button
          variant="primary"
          onClick={() => dispatch({ type: "COMMIT_REQUESTED" })}
          disabled={!acknowledged || committing}
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
