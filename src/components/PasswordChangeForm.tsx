// Three-input password rotation form (current + new + confirm), used
// by the Settings → Account change-password sub-view. Sibling of
// `PasswordCreateForm`; both compose `PasswordInput` so min-strength
// constants (`MIN_PASSWORD_LEN`, `MIN_ZXCVBN_SCORE`) and visual
// discipline are shared structurally.
//
// Submit gating requires Current non-empty — no min-length floor on
// the current password because old vaults may pre-date the current
// `MIN_PASSWORD_LEN` floor; the actual current-password validation is
// the backend AEAD-tag verify on the wrap-key. `SamePasswordRejected`
// is NOT pre-flighted here either; the backend rejects pre-Argon2id
// and the consumer maps the error to the form-level banner. Both
// decisions avoid a frontend gate diverging from the backend's
// canonical reject path.

import { useState, type ReactNode } from "react";
import { Button } from "./primitives/Button";
import { DestructiveBanner } from "./DestructiveBanner";
import { PasswordStrength } from "./PasswordStrength";
import {
  MIN_PASSWORD_LEN,
  MIN_ZXCVBN_SCORE,
  PasswordInput,
  usePasswordStrength,
} from "./PasswordInput";

interface PasswordChangeFormProps {
  /**
   * Called with the validated current + new password when the user
   * submits. The component guarantees non-empty current, new ===
   * confirm, new.length >= MIN_PASSWORD_LEN, and zxcvbn score >=
   * MIN_ZXCVBN_SCORE before invoking. Same-password and wrong-current
   * rejections happen backend-side; the consumer maps the resulting
   * error variant to the `error` prop.
   */
  onSubmit: (currentPassword: string, newPassword: string) => void;
  /**
   * Optional ghost-link Cancel handler rendered in the header row.
   * When omitted, the Cancel link is hidden. Task 10's host
   * (AccountPanel sub-view toggle) provides this to return to the
   * Account panel idle state.
   */
  onCancel?: () => void;
  /**
   * Externally disable submit (e.g., while the backend IPC is
   * in-flight). All three inputs + Submit + Cancel are disabled
   * during this window.
   */
  inFlight?: boolean;
  /**
   * Error message to render in the form-level banner above the
   * inputs. When set, the banner replaces nothing — it appears
   * above the fields and pushes them down. Consumer maps backend
   * `VaultChangePasswordError` variants to LITERAL copy strings
   * (Task 11).
   */
  error?: ReactNode;
}

export function PasswordChangeForm({
  onSubmit,
  onCancel,
  inFlight,
  error,
}: PasswordChangeFormProps) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const { ready: zxcvbnReady, result } = usePasswordStrength(next);

  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LEN;
  const mismatch = confirm.length > 0 && confirm !== next;
  const submitReady =
    current.length > 0 &&
    next.length >= MIN_PASSWORD_LEN &&
    next === confirm &&
    result !== null &&
    result.score >= MIN_ZXCVBN_SCORE;

  let nextCaption: string | undefined;
  let nextTone: "muted" | "danger" | "pending" = "muted";
  let showStrength = false;

  if (next.length === 0) {
    nextCaption = undefined;
    nextTone = "muted";
  } else if (tooShort) {
    nextCaption = `Use at least ${MIN_PASSWORD_LEN} characters.`;
    nextTone = "danger";
  } else if (!zxcvbnReady || !result) {
    nextCaption = "Checking strength…";
    nextTone = "pending";
  } else {
    showStrength = true;
  }

  const handleSubmit = () => {
    if (!submitReady || inFlight) return;
    onSubmit(current, next);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4)",
        alignSelf: "stretch",
        width: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "var(--space-3)",
        }}
      >
        <h3
          style={{
            fontSize: "var(--text-lg)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--fg-1)",
            margin: 0,
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          Change password
        </h3>
        {onCancel && (
          <button
            type="button"
            data-testid="change-password.cancel"
            onClick={onCancel}
            disabled={inFlight}
            style={{
              background: "none",
              border: 0,
              padding: 0,
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-medium)",
              color: "var(--accent)",
              cursor: inFlight ? "default" : "pointer",
            }}
          >
            Cancel
          </button>
        )}
      </div>

      {error && <DestructiveBanner testId="change-password.error">{error}</DestructiveBanner>}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
        }}
      >
        <PasswordInput
          label="Current password"
          testId="change-password.current"
          value={current}
          onChange={setCurrent}
          show={showCurrent}
          onToggleShow={() => setShowCurrent((s) => !s)}
          autoFocus
          disabled={inFlight}
        />

        <PasswordInput
          label="New password"
          testId="change-password.new"
          value={next}
          onChange={setNext}
          show={showNext}
          onToggleShow={() => setShowNext((s) => !s)}
          invalid={tooShort}
          caption={nextCaption}
          captionTone={nextTone}
          disabled={inFlight}
        />

        {showStrength && result && (
          <PasswordStrength
            score={result.score}
            warning={result.warning}
            suggestion={result.suggestion}
          />
        )}

        <PasswordInput
          label="Confirm new password"
          testId="change-password.confirm"
          value={confirm}
          onChange={setConfirm}
          show={showConfirm}
          onToggleShow={() => setShowConfirm((s) => !s)}
          invalid={mismatch}
          caption={mismatch ? "Passwords do not match." : undefined}
          captionTone="danger"
          disabled={inFlight}
        />
      </div>

      <div
        style={{ display: "flex", marginTop: "var(--space-2)" }}
      >
        <Button
          variant="primary"
          data-testid="change-password.submit"
          onClick={handleSubmit}
          disabled={!submitReady || inFlight}
        >
          {inFlight ? "Changing password…" : "Change password"}
        </Button>
      </div>
    </div>
  );
}
