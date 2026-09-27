// The credential field: the app's own Input and Button, on the auth screens
// (myne-md/myne#773).
//
// ── What it replaced, and why ──────────────────────────────────────────────
// A bespoke "deboxed" row: a borderless input at `--text-xl` with a hairline
// under it and a round accent-filled arrow parked at its right end. Every
// piece of it was invented for this one screen, which is exactly what made
// the screen read as somewhere else in the product — the app has an `<Input>`
// and a `<Button>`, uses them in settings, in search and in every dialog, and
// the one surface a new user meets first used neither.
//
// So this composes the primitives and adds nothing: `.myne-input`'s own fill,
// hairline and radius, and a `primary` button under it. The trade is real and
// was taken deliberately — `.myne-input` is 13px, so the credential is no
// longer the largest thing on screen. It is the same size as every other
// field the user will type in for the rest of the session, which is the point.
//
// ── The submit stays visible when the field is empty ───────────────────────
// Disabled, not absent. A control that appears once you start typing makes the
// layout reflow under the caret mid-keystroke, and on a password field the
// user cannot see what they typed, so a moving layout is the only feedback
// they get and it is the wrong feedback.
//
// ── One indicator for the wait ─────────────────────────────────────────────
// Argon2id runs for seconds. The button carries that: a spinner beside a label
// that says what is happening. There is no second indicator anywhere on the
// row (`docs/decisions/ui/0626` withdrew the one there used to be), and no
// motion exemption, because a `<Spinner>` is the app's shared one and already
// holds its own.

import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { Button } from "./Button";
import { Input } from "./Input";
import { Spinner } from "../Spinner";

interface CredentialFieldProps {
  value: string;
  onChange: (next: string) => void;
  /** Accessible name for the input. Required: there is no visible label. */
  ariaLabel: string;
  placeholder?: string;
  /** Work is in flight — the field locks and the button reports it. */
  busy?: boolean;
  /** What the button says while `busy`. */
  busyLabel: string;
  /** What the button says at rest, and its accessible name. */
  submitLabel: string;
  /** Set when the last attempt failed, so the field can say so. */
  invalid?: boolean;
  /** Rendered between the field and the button — an error banner, a hint.
   *  Between, rather than below both: an error belongs against the field that
   *  produced it, not under the control that will retry it. */
  footer?: ReactNode;
  inputProps?: Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "value" | "onChange" | "disabled" | "aria-label" | "style" | "className"
  >;
  testId?: string;
  submitTestId?: string;
}

export function CredentialField({
  value,
  onChange,
  ariaLabel,
  placeholder,
  busy = false,
  busyLabel,
  submitLabel,
  invalid = false,
  footer,
  inputProps,
  testId,
  submitTestId,
}: CredentialFieldProps) {
  const describedBy = useId();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <Input
        {...inputProps}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        disabled={busy}
        aria-label={ariaLabel}
        invalid={invalid}
        aria-describedby={footer != null ? describedBy : undefined}
        placeholder={placeholder}
        data-testid={testId}
      />
      {footer != null && <div id={describedBy}>{footer}</div>}
      <Button
        type="submit"
        variant="primary"
        disabled={busy || value.length === 0}
        // Full width, which `.myne-btn` is not by default — it is an
        // inline-flex control sized to its label, correct in a toolbar and
        // wrong as the one action on a screen. Centred with it, or the label
        // sits left in a button the width of the field.
        style={{ width: "100%", justifyContent: "center" }}
        data-testid={submitTestId}
      >
        {busy && <Spinner size={14} style={{ borderWidth: 2 }} />}
        {busy ? busyLabel : submitLabel}
      </Button>
    </div>
  );
}
