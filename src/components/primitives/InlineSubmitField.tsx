// The deboxed credential row (myne-md/myne#773).
//
// One rule under the text and a round arrow at its right end, instead of a
// bordered rounded input stacked on a full-width accent button.
//
// ── Why the box had to go ──────────────────────────────────────────────────
// A pre-unlock screen asks for exactly one thing. Drawing that one thing as a
// framed input inside a framed card inside an empty window put three
// rectangles around a single question, and the CTA underneath made it read as
// the third row of a settings panel rather than as the door to the vault. The
// deboxed row says the same thing with one line and one button.
//
// ── The submit stays visible when the field is empty ───────────────────────
// Disabled, not absent. A control that appears once you start typing makes the
// row reflow under the caret mid-keystroke, and on a password field the user
// cannot see what they typed, so a moving layout is the only feedback they get
// and it is the wrong feedback.
//
// ── The rule carries the wait ──────────────────────────────────────────────
// Argon2id runs for seconds here. The old CTA said so with a spinner beside its
// label; an icon button has no label to sit beside, so the rule takes the job
// and runs an indeterminate sweep. That sweep is a named exemption in
// `scripts/check-motion-canon.mjs` and carries `data-motion="essential"`, which
// is MYND-630's rule: reduced motion SLOWS state-carrying motion rather than
// freezing it, because a stopped progress indicator reads as a crash.

import {
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { Icon } from "./Icon";
import { Spinner } from "../Spinner";

interface InlineSubmitFieldProps {
  value: string;
  onChange: (next: string) => void;
  /** Accessible name for the input. Required: there is no visible label. */
  ariaLabel: string;
  placeholder?: string;
  /** Work is in flight — the rule sweeps and the arrow becomes a spinner. */
  busy?: boolean;
  /** The label the spinner replaces the arrow's meaning with, for screen readers. */
  busyLabel: string;
  /** Accessible name for the submit control. */
  submitLabel: string;
  /** Set when the last attempt failed, so the field can say so. */
  invalid?: boolean;
  /** Rendered under the row — an error banner, a hint. */
  footer?: ReactNode;
  inputProps?: Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "value" | "onChange" | "disabled" | "aria-label" | "style" | "className"
  >;
  testId?: string;
  submitTestId?: string;
}

export function InlineSubmitField({
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
}: InlineSubmitFieldProps) {
  const [focused, setFocused] = useState(false);
  const describedBy = useId();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <div
        className="myne-inline-field"
        data-focused={focused ? "true" : undefined}
        data-busy={busy ? "true" : undefined}
        // State-carrying, so reduced motion slows the sweep rather than
        // stopping it (MYND-630). On the one screen where a stalled indicator
        // would read as the app having died mid-unlock.
        data-motion={busy ? "essential" : undefined}
      >
        <span className="myne-inline-field__well">
          <input
            {...inputProps}
            className="myne-inline-field__input"
            value={value}
            onChange={(e) => onChange(e.currentTarget.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={busy}
            aria-label={ariaLabel}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={footer != null ? describedBy : undefined}
            placeholder={placeholder}
            data-testid={testId}
          />
          <span className="myne-inline-field__rule" aria-hidden="true" />
          <span className="myne-inline-field__rule myne-inline-field__rule--active" aria-hidden="true" />
        </span>
        <button
          type="submit"
          className="myne-inline-field__submit"
          disabled={busy || value.length === 0}
          // The name changes with the state, because the glyph does: a spinner
          // labelled "Unlock" would tell a screen-reader user nothing has
          // happened yet, on the one screen where seconds of silence is the
          // normal case.
          aria-label={busy ? busyLabel : submitLabel}
          data-testid={submitTestId}
        >
          {busy ? (
            <Spinner size={18} style={{ borderWidth: 2 }} />
          ) : (
            <Icon name="arrow-right" size={20} />
          )}
        </button>
      </div>
      {footer != null && <div id={describedBy}>{footer}</div>}
    </div>
  );
}
