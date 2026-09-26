// `<Switch>` — the app's on/off toggle control (track + sliding knob).
//
// A semantic switch: a `<button role="switch" aria-checked>` rather than a
// styled checkbox, so it is keyboard- and screen-reader-correct by
// construction. Appearance and every state live in `@myne/client-core`'s
// `components.css` under `.myne-switch` (myne-md/myne#773), keyed off
// `aria-checked` and `aria-disabled` — so the painted state and the ANNOUNCED
// state are read from the same attribute and cannot drift apart. That coupling
// is the reason the selectors are ARIA rather than a `data-` flag.
//
// Interactivity follows `onChange` + `disabled`: omit `onChange` (or pass
// `disabled`) to render the dimmed, non-interactive placeholder used for
// tracked-but-not-yet-wired settings. First lifted out of Settings → Privacy's
// screen-capture toggle.
//
// One bug died in the move. The global `button:focus-visible` rule sets
// `border-radius: var(--radius-2)`, and this control is `--radius-3`, so a
// keyboard user watched the pill square off the instant it took focus. A
// component styled inline cannot reach `:focus-visible` to restate its own
// radius; the stylesheet can, and does.

interface SwitchProps {
  /** Current on/off state — drives `aria-checked` and the knob position. */
  checked: boolean;
  /** Toggle handler. Omit to render a disabled placeholder (see file header). */
  onChange?: (next: boolean) => void;
  /** Explicit disable — renders the placeholder visuals even with `onChange`. */
  disabled?: boolean;
  /** Accessible name (the control is icon-only, so this is required in practice). */
  ariaLabel?: string;
  /** Id of the element describing this switch (e.g. a helper paragraph). */
  ariaDescribedBy?: string;
  /** Optional `data-testid` for E2E targeting. */
  testId?: string;
}

export function Switch({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  ariaDescribedBy,
  testId,
}: SwitchProps) {
  const interactive = onChange !== undefined && !disabled;
  return (
    <button
      type="button"
      role="switch"
      className="myne-switch"
      aria-checked={checked}
      aria-disabled={!interactive}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      data-testid={testId}
      // The knob slides along the reading axis via a pixel `translateX`, which
      // has no notion of direction; under RTL the whole track mirrors so "off"
      // rests on the leading (right) edge and slides left when on. (SYNC-4.)
      data-flip=""
      onClick={interactive ? () => onChange(!checked) : undefined}
      disabled={!interactive}
    >
      <span aria-hidden="true" className="myne-switch__knob" />
    </button>
  );
}
