// Shared password form: master-password + confirm fields, zxcvbn
// strength meter, suggest-password helper, min-length + match
// validation, min-strength gating, and the primary submit button.
//
// Two consumers in v0.1:
//   - vault-creation `PasswordStep` (Step 1 of 4 — initial credential)
//   - vault-recover `PasswordResetStep` (post-A8d non-dismissible
//     chained step per `recovery-flow.md` §4.1)
//
// Chrome (heading, eyebrow, layout) lives in the consumer; this
// component renders body-only — error banner slot at top, optional
// helper-copy slot, fields + meter, button row at bottom. zxcvbn-ts
// is lazy-loaded (~140KB gzip) so the Welcome bundle stays lean —
// the chunk arrives when the user first lands on a screen that
// mounts this component.
//
// **Same minimum-strength floor for both consumers.** The constants
// `MIN_PASSWORD_LEN = 12` and `MIN_ZXCVBN_SCORE = 3` are co-located
// with this component so create-time and recover-time gating
// cannot drift. `recovery-flow.md` §4.1 mandates B3a-parity, which
// is enforced structurally by both consumers mounting this same
// component.

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Button } from "./primitives/Button";
import { Input } from "./primitives/Input";
import { Icon } from "./primitives/Icon";
import { PasswordStrength } from "./PasswordStrength";
import { generatePassword } from "../lib/password-generator";
import type { IconName } from "../lib/icons";

export const MIN_PASSWORD_LEN = 12;
export const MIN_ZXCVBN_SCORE = 3;
const SUGGESTED_PASSWORD_LEN = 24;

type ZxcvbnScore = 0 | 1 | 2 | 3 | 4;

interface ZxcvbnResult {
  score: ZxcvbnScore;
  feedback: {
    warning: string;
    suggestions: string[];
  };
}

type ZxcvbnFn = (password: string) => ZxcvbnResult;

type CaptionTone = "muted" | "danger" | "pending";

interface SecondaryAction {
  label: string;
  onClick: () => void;
  icon?: IconName;
}

interface PasswordFormProps {
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
}

const DEFAULT_EMPTY_CAPTION =
  "Used as input to Argon2id (m=256 MiB, t=3, p=2). Choose something you can remember; you cannot reset it.";

export function PasswordForm({
  submitLabel,
  onSubmit,
  disabled,
  errorBanner,
  helperCopy,
  secondaryAction,
  emptyCaption = DEFAULT_EMPTY_CAPTION,
  autoFocus = true,
}: PasswordFormProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [zxcvbnFn, setZxcvbnFn] = useState<ZxcvbnFn | null>(null);

  // Lazy-load zxcvbn-ts: ~140KB gzip stays out of the Welcome bundle
  // and arrives as a separate chunk when the user first lands on a
  // screen that mounts this component.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [core, common, en] = await Promise.all([
        import("@zxcvbn-ts/core"),
        import("@zxcvbn-ts/language-common"),
        import("@zxcvbn-ts/language-en"),
      ]);
      core.zxcvbnOptions.setOptions({
        translations: en.translations,
        graphs: common.adjacencyGraphs,
        dictionary: { ...common.dictionary, ...en.dictionary },
      });
      if (!cancelled) {
        setZxcvbnFn(() => core.zxcvbn as unknown as ZxcvbnFn);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const result = useMemo(
    () => (zxcvbnFn && password ? zxcvbnFn(password) : null),
    [password, zxcvbnFn],
  );

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LEN;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready =
    password.length >= MIN_PASSWORD_LEN &&
    password === confirm &&
    result !== null &&
    result.score >= MIN_ZXCVBN_SCORE;

  let passwordCaption: string | undefined;
  let passwordTone: CaptionTone = "muted";
  let showStrength = false;

  if (password.length === 0) {
    passwordCaption = emptyCaption;
    passwordTone = "muted";
  } else if (tooShort) {
    passwordCaption = `Use at least ${MIN_PASSWORD_LEN} characters.`;
    passwordTone = "danger";
  } else if (!result) {
    passwordCaption = "Checking strength…";
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
    if (!ready || disabled) return;
    onSubmit(password);
  };

  return (
    <>
      {errorBanner}

      {helperCopy}

      <PasswordField
        label="Master password"
        value={password}
        onChange={setPassword}
        show={showPassword}
        onToggleShow={() => setShowPassword((s) => !s)}
        invalid={tooShort}
        caption={passwordCaption}
        captionTone={passwordTone}
        autoFocus={autoFocus}
        labelTrailing={
          <button
            type="button"
            onClick={handleSuggest}
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              fontWeight: 500,
              color: "var(--accent)",
              background: "none",
              border: 0,
              padding: 0,
              cursor: "pointer",
            }}
          >
            Suggest password
          </button>
        }
      />

      {showStrength && result && (
        <PasswordStrength
          score={result.score}
          warning={result.feedback.warning || undefined}
          suggestion={result.feedback.suggestions[0]}
        />
      )}

      <PasswordField
        label="Confirm master password"
        value={confirm}
        onChange={setConfirm}
        show={showConfirm}
        onToggleShow={() => setShowConfirm((s) => !s)}
        invalid={mismatch}
        caption={mismatch ? "Passwords do not match." : undefined}
        captionTone="danger"
      />

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        {secondaryAction && (
          <Button
            variant="ghost"
            onClick={secondaryAction.onClick}
            icon={secondaryAction.icon}
          >
            {secondaryAction.label}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={!ready || disabled}
        >
          {submitLabel}
        </Button>
      </div>
    </>
  );
}

// ---- Internal: PasswordField ----------------------------------------
//
// Single password input with show/hide toggle, optional caption, and
// optional trailing label content (used for the "Suggest password"
// helper button).

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  show: boolean;
  onToggleShow: () => void;
  invalid?: boolean;
  caption?: string;
  captionTone?: CaptionTone;
  autoFocus?: boolean;
  labelTrailing?: ReactNode;
}

const labelStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: 600,
};

function PasswordField({
  label,
  value,
  onChange,
  show,
  onToggleShow,
  invalid,
  caption,
  captionTone = "muted",
  autoFocus,
  labelTrailing,
}: PasswordFieldProps) {
  const captionColor =
    captionTone === "danger" ? "var(--danger)" : "var(--fg-3)";
  const captionFontStyle = captionTone === "pending" ? "italic" : "normal";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <label style={labelStyle}>{label}</label>
        {labelTrailing}
      </div>
      <div style={{ position: "relative" }}>
        <Input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          invalid={invalid}
          autoFocus={autoFocus}
          autoComplete="new-password"
          spellCheck={false}
          style={{ paddingRight: 36 }}
        />
        <button
          type="button"
          onClick={onToggleShow}
          aria-label={show ? "Hide password" : "Show password"}
          style={{
            position: "absolute",
            right: 8,
            top: 7,
            background: "none",
            border: 0,
            color: "var(--fg-3)",
            cursor: "pointer",
            padding: 4,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={show ? "eye-off" : "eye"} size={14} />
        </button>
      </div>
      {caption && (
        <div
          style={{
            fontSize: 12,
            color: captionColor,
            fontStyle: captionFontStyle,
          }}
        >
          {caption}
        </div>
      )}
    </div>
  );
}
