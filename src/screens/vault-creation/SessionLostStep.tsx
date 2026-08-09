// Dedicated error screen for unrecoverable session-loss states
// (SessionExpired, SessionNotFound).
//
// Implements design session 2026-04-28-vault-creation-frontend.md Q7:
//   - Title + body sourced from `state.error` (mapped earlier by
//     mapAppErrorToUserMessage in vault-creation-errors.ts).
//   - Single primary "Start over" button → dispatch RESET → reducer
//     transitions to a fresh password step with all secret material
//     cleared (phrase, accountNumber, sessionToken, confirmInputs,
//     confirmPositions, error all set to initialState defaults).
//   - No eyebrow (this is an error endpoint, not a numbered step).

import type { Dispatch } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { StepHeading, StepLayout } from "./step-shell";
import type { Action, ErrorState } from "./reducer";

interface SessionLostStepProps {
  error: ErrorState;
  dispatch: Dispatch<Action>;
}

export function SessionLostStep({ error, dispatch }: SessionLostStepProps) {
  const { t } = useTranslation();
  return (
    <StepLayout align="center">
      <div style={{ color: "var(--warning)" }}>
        <Icon name="circle-alert" size={36} />
      </div>

      <StepHeading centered>{error.title}</StepHeading>

      <div
        style={{
          fontSize: "var(--text-base)",
          lineHeight: 1.6,
          color: "var(--fg-2)",
          textAlign: "center",
          maxWidth: 360,
        }}
      >
        {error.body}
      </div>

      <Button
        variant="primary"
        onClick={() => dispatch({ type: "RESET" })}
        style={{ marginTop: "var(--space-3)" }}
        data-testid="create.session-lost-start-over"
      >
        {t("vaultCreation.sessionLost.startOver")}
      </Button>
    </StepLayout>
  );
}
