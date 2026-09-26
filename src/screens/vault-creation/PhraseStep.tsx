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

import { type Dispatch } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { SecretPhraseReveal } from "../../components/SecretPhraseReveal";
import { StepEyebrow, StepHeading, StepLayout } from "./step-shell";
import type { Action } from "./reducer";

interface PhraseStepProps {
  phrase: string[];
  revealed: boolean;
  dispatch: Dispatch<Action>;
  /**
   * Abandon the half-made vault and return to the password step.
   *
   * OPTIONAL, and absent means the Back control is not rendered at all rather
   * than rendered and inert. It is absent on the ordering this flow uses where
   * sync is required: there the vault is committed and the account registered
   * BEFORE the phrase is shown, so by the time this screen exists there is no
   * session left to cancel and nothing local to erase that would undo the
   * registration. A Back that dropped the phrase from state would therefore
   * discard, permanently, the only copy of a credential for an account that
   * still exists (`recovery-flow.md` §2.4 is a no-re-display commitment, and
   * `protocol.md` §7 gives the phrase no rotation), through a control labelled
   * "Back". Omitted rather than confirmed: a confirmation would be offering a
   * choice whose safe branch is "do not press this".
   */
  onCancelSession?: () => void;
}

export function PhraseStep({
  phrase,
  revealed,
  dispatch,
  onCancelSession,
}: PhraseStepProps) {
  const { t } = useTranslation();

  return (
    <StepLayout width={600}>
      <StepEyebrow icon="key-round">{t("vaultCreation.phrase.eyebrow")}</StepEyebrow>
      <StepHeading>{t("vaultCreation.phrase.heading")}</StepHeading>

      <div style={{ fontSize: "var(--text-base)", lineHeight: 1.6, color: "var(--fg-2)" }}>
        {t("vaultCreation.phrase.intro")}
      </div>

      <SecretPhraseReveal
        phrase={phrase}
        revealed={revealed}
        onReveal={() => dispatch({ type: "PHRASE_REVEALED" })}
        onHide={() => dispatch({ type: "PHRASE_HIDDEN" })}
        testIdPrefix="create.phrase"
        saveFilename="myne-recovery-phrase.txt"
      />

      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        {onCancelSession && (
          <Button
            variant="ghost"
            onClick={onCancelSession}
            icon="arrow-left"
            data-testid="create.phrase-back"
          >
            {t("vaultCreation.phrase.back")}
          </Button>
        )}
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
