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
import { StepCounter, StepHeading, StepLayout } from "./step-shell";
import { normalizeWord, type Action, type ErrorState } from "./reducer";

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

const labelStyle = {
  fontSize: 12,
  color: "var(--fg-3)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.08em",
  fontWeight: "var(--weight-semibold)",
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
        icon="check"
        label={t("vaultCreation.confirm.eyebrowLabel")}
      />
      <StepHeading>{t("vaultCreation.confirm.heading")}</StepHeading>

      <div style={{ fontSize: "var(--text-base)", lineHeight: 1.6, color: "var(--fg-2)" }}>
        {t("vaultCreation.confirm.intro")}
      </div>

      {error && error.displayMode === "inline" && <ErrorBanner error={error} />}

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {positions.map((pos, idx) => {
          const inputId = `confirm-input-${pos}`;
          const value = inputs[pos] ?? "";
          const invalid = matches[idx] === false;
          return (
            <div
              key={pos}
              style={{ display: "flex", flexDirection: "column", gap: 6 }}
            >
              <label htmlFor={inputId} style={labelStyle}>
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
                  style={{ fontSize: 12, color: "var(--danger)" }}
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

      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        <Button
          variant="ghost"
          onClick={() => dispatch({ type: "CONFIRM_BACK" })}
          icon="arrow-left"
          disabled={committing}
          data-testid="create.confirm-back"
        >
          {t("vaultCreation.confirm.back")}
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
