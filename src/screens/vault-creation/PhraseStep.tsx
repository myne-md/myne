// Step 2 of 4 — recovery phrase reveal + Copy/Save + acknowledgement.
//
// Implements design session 2026-04-28-vault-creation-frontend.md:
//   - Q4.1 reveal pattern: blur-by-default + click reveal + window-blur
//     listener that re-blurs on Cmd-Tab / app-switch (walk-away guard).
//   - Q4.2 actions: Copy + Save-as-file via Tauri plugins; clipboard
//     auto-clear after 30 s with a read-precondition (only clear if the
//     content still matches the phrase we wrote, so we never nuke the
//     user's later clipboard).
//   - Q4.3 hierarchy: Copy + Save are ghost variant; "I've saved this →
//     confirm phrase" is the visually primary CTA.
//   - Q8.1 Back from PhraseStep dispatches RESET_TO_PASSWORD; the
//     orchestrator's effect (this file calls a callback) fires
//     `cancel(sessionToken)` and resets the reducer to a fresh password
//     step. No confirmation modal — the user has not saved anything yet.
//   - Q10 step indicator: STEP 2 OF 4 — RECOVERY PHRASE.
//
// Spec: protocol.md § 7 (BIP-39 24-word, English wordlist) + § 7.5.

import { useEffect, useMemo, useRef, type Dispatch } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import {
  copySecretToClipboard,
  saveSecretAsTextFile,
} from "../../lib/secret-export";
import { StepEyebrow, StepHeading, StepLayout } from "./step-shell";
import type { Action } from "./reducer";

interface PhraseStepProps {
  phrase: string[];
  revealed: boolean;
  dispatch: Dispatch<Action>;
  onCancelSession: () => void;
}

export function PhraseStep({
  phrase,
  revealed,
  dispatch,
  onCancelSession,
}: PhraseStepProps) {
  const { t } = useTranslation();
  // Re-blur when the user Cmd-Tabs or the OS hides the window.
  useEffect(() => {
    const onBlur = () => dispatch({ type: "PHRASE_HIDDEN" });
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [dispatch]);

  const phraseString = useMemo(() => phrase.join(" "), [phrase]);

  // Cancel any pending clipboard auto-clear on unmount so the timer's
  // closure (which captures the 24-word phrase) is released promptly.
  const cancelAutoClearRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      cancelAutoClearRef.current?.();
    },
    [],
  );

  const handleCopy = async () => {
    cancelAutoClearRef.current?.();
    cancelAutoClearRef.current = await copySecretToClipboard(phraseString);
  };

  const handleSave = () =>
    saveSecretAsTextFile("myne-recovery-phrase.txt", phraseString);

  return (
    <StepLayout width={600}>
      <StepEyebrow icon="key-round">{t("vaultCreation.phrase.eyebrow")}</StepEyebrow>
      <StepHeading>{t("vaultCreation.phrase.heading")}</StepHeading>

      <div style={{ fontSize: "var(--text-base)", lineHeight: 1.6, color: "var(--fg-2)" }}>
        {t("vaultCreation.phrase.intro")}
      </div>

      <div style={{ position: "relative" }}>
        <div
          data-testid="create.phrase-grid"
          data-revealed={revealed}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 6,
            padding: "var(--space-4)",
            background: "var(--paper-2)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-2)",
            filter: revealed ? "none" : "blur(8px)",
            transition: "filter 180ms cubic-bezier(0.2,0,0,1)",
            userSelect: revealed ? "text" : "none",
          }}
        >
          {phrase.map((word, i) => (
            <div
              key={i}
              data-testid="create.phrase-word"
              data-index={i + 1}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 6,
                padding: "6px 10px",
                background: "var(--bg-1)",
                border: "1px solid var(--line-1)",
                borderRadius: "var(--radius-1)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-sm)",
                fontFeatureSettings: '"ss02","zero","calt"',
              }}
            >
              <span
                style={{
                  color: "var(--fg-3)",
                  minWidth: 18,
                  textAlign: "end",
                }}
              >
                {i + 1}
              </span>
              <span style={{ color: "var(--fg-1)" }}>{word}</span>
            </div>
          ))}
        </div>
        {!revealed && (
          <button
            type="button"
            onClick={() => dispatch({ type: "PHRASE_REVEALED" })}
            data-testid="create.phrase-reveal"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: 0,
              cursor: "pointer",
              color: "var(--fg-1)",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-medium)",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-2)",
                padding: "8px 14px",
                background: "var(--bg-1)",
                border: "1px solid var(--line-2)",
                borderRadius: "var(--radius-2)",
              }}
            >
              <Icon name="eye" size={14} />
              {t("vaultCreation.phrase.reveal")}
            </span>
          </button>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Button variant="ghost" icon="copy" onClick={handleCopy}>
          {t("vaultCreation.phrase.copy")}
        </Button>
        <Button variant="ghost" icon="download" onClick={handleSave}>
          {t("vaultCreation.phrase.saveAsFile")}
        </Button>
      </div>

      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        <Button
          variant="ghost"
          onClick={onCancelSession}
          icon="arrow-left"
          data-testid="create.phrase-back"
        >
          {t("vaultCreation.phrase.back")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button
          variant="primary"
          onClick={() => dispatch({ type: "PHRASE_ACKED" })}
          data-testid="create.phrase-continue"
        >
          {t("vaultCreation.phrase.continue")}
        </Button>
      </div>
    </StepLayout>
  );
}
