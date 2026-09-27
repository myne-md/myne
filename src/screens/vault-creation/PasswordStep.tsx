// Step 2 of 4 — master password.
//
// Implements design session 2026-04-28-vault-creation-frontend.md:
//   - Q2 state machine (PasswordStep is a leaf component; password lives
//     in `<PasswordCreateForm>`'s local state, never in the reducer's
//     secret-material scope; submit calls `onSubmit(password)` and the
//     orchestrator captures the value via a ref for the begin invocation).
//   - Q7 error UX (inline error banner for recoverable BEGIN_ERR variants
//     via <ErrorBanner role="alert">).
//   - Q10 step indicator, now composed from `stepOrder.ts` rather than being
//     one translated string per step (myne-md/myne#468 — see that file for why).
//
// Body (password + confirm fields, zxcvbn meter, suggest helper, min-
// strength gating, submit button) is delegated to the shared
// `<PasswordCreateForm>` component (`src/components/PasswordCreateForm.tsx`)
// so vault-recover's post-recovery password reset (`recovery-flow.md`
// §4.1) consumes the same gating + visual surface — drift between
// create-time and recover-time minimum-strength rules is structurally
// impossible. The change-password flow uses a sibling `PasswordChangeForm`
// component that stacks a third "current password" input on top of the
// same `PasswordInput` primitive (`decisions.md` 2026-05-08 desktop modal
// carve-out + Settings 5-panel taxonomy entry; MYND-87 + MYND-107).
//
// No console.log of password contents anywhere in this file.

import { useTranslation } from "react-i18next";
import { ErrorBanner } from "../../components/ErrorBanner";
import { PasswordCreateForm } from "../../components/PasswordCreateForm";
import { LOST_BOTH_SECRETS_SENTENCE } from "../../lib/load-bearing-copy";
import { StepCounter, StepHeading, StepLayout } from "./step-shell";
import type { ErrorState } from "./reducer";

interface PasswordStepProps {
  error: ErrorState | null;
  /**
   * One step BACK, to the vault-name step — not out of the flow. Something
   * precedes the password now, so this control returns to it with the typed name
   * intact (`PASSWORD_BACK`), where before it exited creation entirely.
   */
  onBack: () => void;
  onSubmit: (password: string) => void;
}

export function PasswordStep({ error, onBack, onSubmit }: PasswordStepProps) {
  const { t } = useTranslation();
  return (
    <StepLayout>
      <StepCounter
        step="password"
        icon="lock"
        label={t("vaultCreation.password.eyebrowLabel")}
      />
      <StepHeading>{t("vaultCreation.password.heading")}</StepHeading>

      <PasswordCreateForm
        submitLabel={t("vaultCreation.password.submit")}
        onSubmit={onSubmit}
        testIdPrefix="create"
        secondaryAction={{
          label: t("vaultCreation.password.back"),
          onClick: onBack,
          icon: "arrow-left",
        }}
        errorBanner={
          error && error.displayMode === "inline" ? (
            <ErrorBanner error={error} />
          ) : undefined
        }
        helperCopy={
          <div
            style={{
              padding: "var(--space-3)",
              background: "var(--paper-2)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-2)",
              fontSize: "var(--text-sm)",
              lineHeight: 1.6,
              color: "var(--fg-2)",
            }}
          >
            {t("vaultCreation.password.helperLead")}{" "}
            <strong style={{ color: "var(--fg-1)" }}>
              {LOST_BOTH_SECRETS_SENTENCE}
            </strong>
          </div>
        }
      />
    </StepLayout>
  );
}
