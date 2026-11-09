// Step 4 of 4 — the phrase confirmation challenge, and the commit.
//
// Implements design session 2026-04-28-vault-creation-frontend.md Q3:
//   - Spec § 7.1.3 normative: "demonstrate the phrase, not memorize" —
//     bare checkbox is insufficient.
//   - 4 random positions selected at BEGIN_OK (biased: 1 from [1,8] +
//     2 from [9,16] + 1 from [17,24]); positions stable across
//     CONFIRM_BACK navigation.
//   - NFKD-normalize + lowercase + trim before compare (handled by
//     `normalizeWord` helper in the reducer module).
//   - Inline position-specific error: "Doesn't match word #N".
//   - Primary action disabled until all 4 positions match.
//   - Back button → CONFIRM_BACK (no cancel — same session, navigation
//     only; confirmInputs preserved per design session Q3 stability).
//
// This is now the LAST step, and so it is where the vault is created
// (myne-md/myne#468). The account number used to have a step after this one,
// carrying the commit button and a "I have saved my account number" checkbox;
// both moved into the recovery kit two screens back, the checkbox by deletion.
// So the challenge this step already ran is what gates the commit, which is the
// stronger of the two gates rather than a relaxation: § 7.1.3 says in as many
// words that a checkbox is not evidence.
//
// Two states it gained with the commit: an inline COMMIT_ERR banner (routed here
// by the reducer, since this is where the request came from) and the in-flight
// spinner, which stays inline — an atomic sub-second write does not earn a
// full-screen transition (design session Q6.2).
//
// Spec: protocol.md § 7.1.3 (phrase confirmation challenge).

import { useMemo, type Dispatch } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Input } from "../../components/primitives/Input";
import { Spinner } from "../../components/Spinner";
import { ErrorBanner } from "../../components/ErrorBanner";
import { StepCard, StepCounter, StepHeading, StepLayout } from "./step-shell";
import { normalizeWord, type Action, type ErrorState } from "./reducer";
import { distributePhrasePaste } from "../../components/PhraseTypeBack";

interface ConfirmStepProps {
  phrase: string[];
  positions: readonly [number, number, number, number];
  inputs: Readonly<Record<number, string>>;
  /** True while `vault-creation|commit` is in flight. */
  committing: boolean;
  /** Inline COMMIT_ERR banner; `dedicated` errors route to <SessionLostStep>. */
  error: ErrorState | null;
  dispatch: Dispatch<Action>;
}

/** Sentence case, like every other field label on the first-run steps. */
const WORD_LABEL_STYLE = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

export function ConfirmStep({
  phrase,
  positions,
  inputs,
  committing,
  error,
  dispatch,
}: ConfirmStepProps) {
  const { t } = useTranslation();
  // NFKD normalization on every keystroke for all 4 targets adds up;
  // pre-normalize once per phrase/positions pair.
  const targets = useMemo(
    () => positions.map((pos) => normalizeWord(phrase[pos - 1])),
    [positions, phrase],
  );

  const matches = positions.map((pos, idx) => {
    const value = inputs[pos] ?? "";
    if (value.length === 0) return null;
    return normalizeWord(value) === targets[idx];
  });
  const allMatch = matches.every((m) => m === true);

  return (
    <StepLayout>
      <StepCounter
        step="confirm"
        label={t("vaultCreation.confirm.eyebrowLabel")}
      />
      <StepHeading>{t("vaultCreation.confirm.heading")}</StepHeading>

      <div style={{ fontSize: "var(--text-base)", lineHeight: 1.6, color: "var(--fg-2)" }}>
        {t("vaultCreation.confirm.intro")}
      </div>

      {error && error.displayMode === "inline" && <ErrorBanner error={error} />}

      {/* Two by two on a card: four words is one small task, and a grid of
          short fields reads as that where a column of four full-width fields
          read as a form to fill in. */}
      <StepCard>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: "var(--space-4)",
          }}
        >
        {positions.map((pos, idx) => {
          const inputId = `confirm-input-${pos}`;
          const value = inputs[pos] ?? "";
          const invalid = matches[idx] === false;
          return (
            <div
              key={pos}
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
            >
              <label htmlFor={inputId} style={WORD_LABEL_STYLE}>
                {t("vaultCreation.confirm.wordAtPosition", { pos })}
              </label>
              <Input
                id={inputId}
                // Pinned left-to-right for the same reason the grid is: the words
                // are frozen English (`protocol.md` §7) and under an RTL locale a
                // logical-direction field puts the caret and the rendered text on
                // the wrong side of a secret whose order cannot be re-checked.
                dir="ltr"
                type="text"
                value={value}
                onChange={(e) =>
                  dispatch({
                    type: "CONFIRM_INPUT_CHANGED",
                    position: pos,
                    value: e.target.value,
                  })
                }
                // A whole phrase pasted into one box lands in the four boxes it
                // belongs to, by position (myne-md/myne#945 item 04). The
                // identity ceremony's challenge shares the rule through
                // `distributePhrasePaste`, so the two ceremonies cannot disagree
                // about what a paste means.
                onPaste={(e) => {
                  const distributed = distributePhrasePaste(
                    e.clipboardData.getData("text"),
                    positions,
                  );
                  if (distributed === null) return;
                  e.preventDefault();
                  for (const [position, word] of distributed) {
                    dispatch({
                      type: "CONFIRM_INPUT_CHANGED",
                      position,
                      value: word,
                    });
                  }
                }}
                invalid={invalid}
                autoComplete="off"
                spellCheck={false}
                mono
                autoFocus={idx === 0}
                data-testid="create.confirm-input"
                data-index={pos}
              />
              {invalid && (
                <div
                  style={{ fontSize: "var(--text-xs)", color: "var(--danger)" }}
                  data-testid="create.confirm-error"
                  data-index={pos}
                >
                  {t("vaultCreation.confirm.mismatch", { pos })}
                </div>
              )}
            </div>
          );
        })}
        </div>
      </StepCard>

      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button
          variant="ghost"
          onClick={() => dispatch({ type: "CONFIRM_BACK" })}
          icon="arrow-left"
          disabled={committing}
          data-testid="create.confirm-back"
        >
          {t("common.back")}
        </Button>
        <div style={{ flex: 1 }} />
        {/* One testid, and it stays `create.confirm-continue`: this control is
            the challenge's Continue that also commits, not the old account
            step's button moved here. The scenarios that addressed
            `create.account-commit` are updated rather than aliased — an
            attribute nothing reads would be a second name for one control and a
            reader would have to grep the tree to learn that. */}
        <Button
          variant="primary"
          onClick={() => dispatch({ type: "COMMIT_REQUESTED" })}
          disabled={!allMatch || committing}
          data-testid="create.confirm-continue"
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
            ? t("vaultCreation.confirm.committing")
            : t("vaultCreation.confirm.commit")}
        </Button>
      </div>
    </StepLayout>
  );
}
