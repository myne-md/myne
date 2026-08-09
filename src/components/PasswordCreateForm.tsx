// Two-input password form: master password + confirm. Used by every
// flow that *creates* a credential — vault-creation `PasswordStep`
// (Step 1 of 4) and vault-recover `PasswordResetStep` (post-A8d
// non-dismissible chained step per `recovery-flow.md` §4.1). The
// change-password flow lives in a sibling component
// (`PasswordChangeForm`) because it adds a third "current password"
// input above these two.
//
// Body-only render — chrome (heading, eyebrow, layout) lives in the
// consumer. The component renders an optional error banner, optional
// helper-copy slot, the password field with strength meter, the
// confirm field, and the button row.
//
// Min-strength gating + zxcvbn lazy-load are owned by the underlying
// `PasswordInput` primitive's `usePasswordStrength` hook — this form
// reads `MIN_PASSWORD_LEN`, `MIN_ZXCVBN_SCORE` and the
// `passwordLength` scalar-value counter from there for the ready gate.
// Forms can never drift on those constants — or on the unit the floor
// is counted in — because there is one canonical home.
//
// Renamed from `PasswordForm.tsx` in MYND-87+107's Task 3 refactor.
// API surface preserved (`PasswordCreateForm` accepts the same prop
// shape `PasswordForm` accepted); the rename signals which flow this
// form serves vs `PasswordChangeForm`.

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./primitives/Button";
import { PasswordStrength } from "./PasswordStrength";
import {
  MIN_PASSWORD_LEN,
  MIN_ZXCVBN_SCORE,
  PasswordInput,
  passwordLength,
  usePasswordStrength,
} from "./PasswordInput";
import { generatePassword } from "../lib/password-generator";
import type { IconName } from "../lib/icons";

const SUGGESTED_PASSWORD_LEN = 24;

interface SecondaryAction {
  label: string;
  onClick: () => void;
  icon?: IconName;
}

interface PasswordCreateFormProps {
  /** Label for the primary submit button. */
  submitLabel: string;
  /** Called with the validated password when the user submits. */
  onSubmit: (password: string) => void;
  /**
   * Externally disable submit (e.g., while an IPC call is in flight
   * after a prior submit). The internal `ready` gate still applies —
   * `disabled` only widens the disabled set, never narrows it.
   */
  disabled?: boolean;
  /**
   * Rendered at the top of the body, above the helper copy. Use for
   * a flow-specific error banner (e.g., `<ErrorBanner error={...} />`
   * on vault-creation, a generic recover-side banner on the recover
   * password-reset step).
   */
  errorBanner?: ReactNode;
  /**
   * Rendered between the error banner and the password fields. Use
   * for flow-specific helper paragraph copy (e.g., the "Myne does
   * not store..." note on vault-creation, a "your old password is
   * about to be replaced" note on recover).
   */
  helperCopy?: ReactNode;
  /**
   * Optional secondary action rendered to the left of the primary
   * submit. Vault-creation uses this for "Back"; recover's
   * password-reset omits it (non-dismissible per `recovery-flow.md`
   * §4.1).
   */
  secondaryAction?: SecondaryAction;
  /**
   * Caption shown below the password field when it is empty. Default
   * is the create-time wording about Argon2id; recover may override.
   */
  emptyCaption?: string;
  /** Auto-focus the password field on mount. Default: true. */
  autoFocus?: boolean;
  /**
   * Stable E2E selector prefix (SYNC-8). When set, the form renders
   * `data-testid` on its interactive elements:
   * `<prefix>.password-input`, `<prefix>.confirm-input`,
   * `<prefix>.submit`.
   */
  testIdPrefix?: string;
}

export function PasswordCreateForm({
  submitLabel,
  onSubmit,
  disabled,
  errorBanner,
  helperCopy,
  secondaryAction,
  emptyCaption,
  autoFocus = true,
  testIdPrefix,
}: PasswordCreateFormProps) {
  const { t } = useTranslation();
  // Resolve the default at render time (not module scope) so a language switch
  // re-renders the caption.
  const resolvedEmptyCaption = emptyCaption ?? t("password.createForm.defaultEmptyCaption");
  const tid = (suffix: string) => (testIdPrefix ? `${testIdPrefix}.${suffix}` : undefined);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const { ready: zxcvbnReady, result } = usePasswordStrength(password);

  // Unicode scalar values, not `.length` — same unit as the backend
  // floor (see `passwordLength`).
  const passwordLen = passwordLength(password);
  const tooShort = passwordLen > 0 && passwordLen < MIN_PASSWORD_LEN;
  const mismatch = confirm.length > 0 && confirm !== password;
  const submitReady =
    passwordLen >= MIN_PASSWORD_LEN &&
    password === confirm &&
    result !== null &&
    result.score >= MIN_ZXCVBN_SCORE;

  let passwordCaption: string | undefined;
  let passwordTone: "muted" | "danger" | "pending" = "muted";
  let showStrength = false;

  if (passwordLen === 0) {
    passwordCaption = resolvedEmptyCaption;
    passwordTone = "muted";
  } else if (tooShort) {
    passwordCaption = t("password.createForm.tooShort", { n: MIN_PASSWORD_LEN });
    passwordTone = "danger";
  } else if (!zxcvbnReady || !result) {
    passwordCaption = t("password.createForm.checkingStrength");
    passwordTone = "pending";
  } else {
    showStrength = true;
  }

  const handleSuggest = () => {
    const generated = generatePassword(SUGGESTED_PASSWORD_LEN);
    setPassword(generated);
    setConfirm(generated);
    setShowPassword(true);
    setShowConfirm(true);
  };

  const handleSubmit = () => {
    if (!submitReady || disabled) return;
    onSubmit(password);
  };

  return (
    <>
      {errorBanner}

      {helperCopy}

      <PasswordInput
        label={t("password.createForm.passwordLabel")}
        value={password}
        onChange={setPassword}
        show={showPassword}
        onToggleShow={() => setShowPassword((s) => !s)}
        invalid={tooShort}
        caption={passwordCaption}
        captionTone={passwordTone}
        autoFocus={autoFocus}
        disabled={disabled}
        testId={tid("password-input")}
        labelTrailing={
          <button
            type="button"
            onClick={handleSuggest}
            disabled={disabled}
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              fontWeight: "var(--weight-medium)",
              color: "var(--accent)",
              background: "none",
              border: 0,
              padding: 0,
              cursor: disabled ? "default" : "pointer",
            }}
          >
            {t("password.createForm.suggestPassword")}
          </button>
        }
      />

      {showStrength && result && (
        <PasswordStrength
          score={result.score}
          warning={result.warning}
          suggestion={result.suggestion}
        />
      )}

      <PasswordInput
        label={t("password.createForm.confirmLabel")}
        value={confirm}
        onChange={setConfirm}
        show={showConfirm}
        onToggleShow={() => setShowConfirm((s) => !s)}
        invalid={mismatch}
        caption={mismatch ? t("password.createForm.mismatch") : undefined}
        captionTone="danger"
        disabled={disabled}
        testId={tid("confirm-input")}
      />

      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        {secondaryAction && (
          <Button
            variant="ghost"
            onClick={secondaryAction.onClick}
            icon={secondaryAction.icon}
            data-testid={tid("secondary")}
          >
            {secondaryAction.label}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={!submitReady || disabled}
          data-testid={tid("submit")}
        >
          {submitLabel}
        </Button>
      </div>
    </>
  );
}
