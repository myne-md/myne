// Step 3 of 4 — phrase confirmation challenge.
//
// Implements design session 2026-04-28-vault-creation-frontend.md Q3:
//   - Spec § 7.1.3 normative: "demonstrate the phrase, not memorize" —
//     bare checkbox is insufficient.
//   - 4 random positions selected at BEGIN_OK (biased: 1 from [1,8] +
//     2 from [9,16] + 1 from [17,24]); positions stable across
//     CONFIRM_BACK / ACCOUNT_BACK navigation.
//   - NFKD-normalize + lowercase + trim before compare (handled by
//     `normalizeWord` helper in the reducer module).
//   - Inline position-specific error: "Doesn't match word #N".
//   - Continue button disabled until all 4 positions match.
//   - Back button → CONFIRM_BACK (no cancel — same session, navigation
//     only; confirmInputs preserved per design session Q3 stability).
//
// Spec: protocol.md § 7.1.3 (phrase confirmation challenge).

import { useMemo, type Dispatch } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Input } from "../../components/primitives/Input";
import { StepEyebrow, StepHeading, StepLayout } from "./step-shell";
import { normalizeWord, type Action } from "./reducer";

interface ConfirmStepProps {
  phrase: string[];
  positions: readonly [number, number, number, number];
  inputs: Readonly<Record<number, string>>;
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
      <StepEyebrow icon="check">{t("vaultCreation.confirm.eyebrow")}</StepEyebrow>
      <StepHeading>{t("vaultCreation.confirm.heading")}</StepHeading>

      <div style={{ fontSize: "var(--text-base)", lineHeight: 1.6, color: "var(--fg-2)" }}>
        {t("vaultCreation.confirm.intro")}
      </div>

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
          data-testid="create.confirm-back"
        >
          {t("vaultCreation.confirm.back")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button
          variant="primary"
          onClick={() => dispatch({ type: "PHRASE_CONFIRMED" })}
          disabled={!allMatch}
          data-testid="create.confirm-continue"
        >
          {t("vaultCreation.confirm.continue")}
        </Button>
      </div>
    </StepLayout>
  );
}
