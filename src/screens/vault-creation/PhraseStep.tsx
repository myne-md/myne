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
import { CopyStatus, useCopyStatus } from "../../components/CopyStatus";
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

  // myne-md/myne#390: this step had no copy feedback at all, and no i18n keys
  // for one, it was never given the affordance rather than given it wrongly.
  const { outcome, markCopied, markFailed } = useCopyStatus();

  // This used to cancel the pending auto-clear on unmount, and that was wrong in
  // a way the copy made visible (myne-md/myne#390): advancing to the confirm step
  // is the intended next action and takes seconds, so cancelling there left the
  // twenty-four words on the system clipboard PERMANENTLY, while the screen had
  // just said they would clear in thirty seconds. A promise the mechanism cannot
  // keep is the exact class of claim this feature exists to remove.
  //
  // The cancel existed for a heap reason that no longer applies: the timer's
  // closure used to capture the phrase for the whole window. `copySecret` now
  // releases it on both exits (`src/lib/clipboard.ts`), so what remains is a
  // 30 s reference in a process that already holds the phrase in React state -
  // not a new exposure, and far cheaper than an indefinite one on a clipboard
  // every other app can read.
  //
  // Letting it fire after unmount is safe: the clear is the host-side
  // compare-and-clear, so it only wipes the clipboard if the phrase is still on
  // it. A user who copied something else in the window keeps it.
  const cancelAutoClearRef = useRef<(() => void) | null>(null);

  const handleCopy = async () => {
    cancelAutoClearRef.current?.();
    // The surface myne-md/myne#390 opened on, and the reason both arms are INLINE
    // and persistent rather than toasts. This is the screen where the twenty-four
    // words are shown ONCE and never again. Before this, pressing Copy changed
    // nothing on screen whether it worked or not, so "I pressed Copy" was not
    // evidence the phrase was anywhere, and a user who believed a failed copy
    // had worked has an unrecoverable vault the moment they leave.
    //
    // A transient toast would be the weakest option available here: on a
    // shown-once screen, a confirmation the user can miss is barely better than
    // none.
    cancelAutoClearRef.current = await copySecretToClipboard(phraseString, {
      onSuccess: { kind: "inline", run: markCopied },
      onFailure: { kind: "inline", run: markFailed },
    });
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
        <Button variant="ghost" icon="copy" onClick={handleCopy} data-testid="create.phrase-copy">
          {t("vaultCreation.phrase.copy")}
        </Button>
        <Button variant="ghost" icon="download" onClick={handleSave}>
          {t("vaultCreation.phrase.saveAsFile")}
        </Button>
      </div>

      {/* Both outcomes render here, unlike the account step's, because the Copy
          button's own label does NOT swap on this screen, so without this line
          a successful copy would still be invisible. */}
      <CopyStatus
        testId="create.phrase-copy-status"
        message={
          outcome === "copied"
            ? t("vaultCreation.phrase.copied")
            : outcome === "failed"
              ? t("vaultCreation.phrase.copyFailed")
              : null
        }
      />

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
