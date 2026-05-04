// Step 1 of 4 — master password.
//
// Implements design session 2026-04-28-vault-creation-frontend.md:
//   - Q2 state machine (PasswordStep is a leaf component; password lives
//     in `<PasswordForm>`'s local state, never in the reducer's secret-
//     material scope; submit calls `onSubmit(password)` and the
//     orchestrator captures the value via a ref for the begin invocation).
//   - Q7 error UX (inline error banner for recoverable BEGIN_ERR variants
//     via <ErrorBanner role="alert">).
//   - Q10 step indicator ("STEP 1 OF 4 — MASTER PASSWORD" eyebrow).
//
// Body (password + confirm fields, zxcvbn meter, suggest helper, min-
// strength gating, submit button) is delegated to the shared
// `<PasswordForm>` component (`src/components/PasswordForm.tsx`) so
// vault-recover's post-recovery password reset (`recovery-flow.md`
// §4.1) consumes the same gating + visual surface — drift between
// create-time and recover-time minimum-strength rules is structurally
// impossible.
//
// No console.log of password contents anywhere in this file.

import { ErrorBanner } from "../../components/ErrorBanner";
import { PasswordForm } from "../../components/PasswordForm";
import { StepEyebrow, StepHeading, StepLayout } from "./step-shell";
import type { ErrorState } from "./reducer";

interface PasswordStepProps {
  error: ErrorState | null;
  onBack: () => void;
  onSubmit: (password: string) => void;
}

export function PasswordStep({ error, onBack, onSubmit }: PasswordStepProps) {
  return (
    <StepLayout>
      <StepEyebrow icon="lock">Step 1 of 4 — master password</StepEyebrow>
      <StepHeading>Create vault</StepHeading>

      <PasswordForm
        submitLabel="Generate recovery phrase"
        onSubmit={onSubmit}
        secondaryAction={{ label: "Back", onClick: onBack, icon: "arrow-left" }}
        errorBanner={
          error && error.displayMode === "inline" ? (
            <ErrorBanner error={error} />
          ) : undefined
        }
        helperCopy={
          <div
            style={{
              padding: 12,
              background: "var(--paper-2)",
              border: "1px solid var(--line-1)",
              borderRadius: 6,
              fontSize: 13,
              lineHeight: 1.6,
              color: "var(--fg-2)",
            }}
          >
            Myne does not store your password or recovery phrase.{" "}
            <strong style={{ color: "var(--fg-1)" }}>
              If you lose both your password and recovery phrase, your notes
              are unrecoverable. We cannot help.
            </strong>
          </div>
        }
      />
    </StepLayout>
  );
}
