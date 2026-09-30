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

import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
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
  /**
   * Offer an eye toggle inside the field that shows the typed value in the
   * clear and hides it again. The two strings are the toggle's accessible name
   * in each state ("Show password" / "Hide password"). Absent means no toggle.
   */
  reveal?: { show: string; hide: string };
}

const STATUS_STYLE = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  textAlign: "center",
} as const;

/** The eye, pinned inside the field's end edge and centred on its height. */
const REVEAL_SLOT_STYLE = {
  position: "absolute",
  insetInlineEnd: 4,
  top: "50%",
  transform: "translateY(-50%)",
  display: "flex",
} as const;

/** A square icon button, as tall as the field beside it. */
const SUBMIT_STYLE = {
  flexShrink: 0,
  width: 40,
  padding: 0,
  justifyContent: "center",
} as const;

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
  reveal,
}: CredentialFieldProps) {
  const describedBy = useId();
  const [revealed, setRevealed] = useState(false);
  // Revealing swaps the field's type; hiding restores whatever the caller
  // asked for (always `password` today).
  const type = reveal && revealed ? "text" : inputProps?.type;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {/* The field and its submit on one line: an arrow beside the input is the
          whole instruction, where a full-width labelled button under it said
          the same thing a second time. The button's accessible name is still
          the label ("Unlock", "Unlock with PIN") and becomes the busy label
          while the KDF runs, so a screen reader hears what the spinner shows. */}
      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "stretch" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 0, display: "flex" }}>
          <Input
            {...inputProps}
            type={type}
            value={value}
            onChange={(e) => onChange(e.currentTarget.value)}
            disabled={busy}
            aria-label={ariaLabel}
            invalid={invalid}
            aria-describedby={footer != null ? describedBy : undefined}
            placeholder={placeholder}
            data-testid={testId}
            // Room on the right for the eye, so a long value never runs under it.
            style={{ flex: 1, minWidth: 0, ...(reveal ? { paddingInlineEnd: 36 } : null) }}
          />
          {reveal && (
            <span style={REVEAL_SLOT_STYLE}>
              <IconButton
                icon={revealed ? "eye-off" : "eye"}
                label={revealed ? reveal.hide : reveal.show}
                onClick={() => setRevealed((r) => !r)}
                disabled={busy}
                active={revealed}
                testId={testId ? `${testId}-reveal` : undefined}
              />
            </span>
          )}
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || value.length === 0}
          aria-label={busy ? busyLabel : submitLabel}
          title={submitLabel}
          style={SUBMIT_STYLE}
          data-testid={submitTestId}
        >
          {busy ? (
            // Decorative here: the status line below is the announcement, and a
            // second `role="status"` would make a screen reader say it twice.
            <span aria-hidden="true" style={{ display: "flex" }}>
              <Spinner size={14} style={{ borderWidth: 2 }} />
            </span>
          ) : (
            <Icon name="arrow-right" size={16} />
          )}
        </Button>
      </div>
      {/* The wait in words. The button shrank to an arrow, so the label that
          used to say "Decrypting…" inside it now says it under the field: the
          KDF runs for seconds, and a spinner alone gives a sighted user no word
          and a screen-reader user nothing at all. `role="status"` announces it. */}
      {busy && (
        <p role="status" data-testid={testId ? `${testId}-status` : undefined} style={STATUS_STYLE}>
          {busyLabel}
        </p>
      )}
      {footer != null && <div id={describedBy}>{footer}</div>}
    </div>
  );
}
