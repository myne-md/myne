// `<Switch>` — the app's on/off toggle control (track + sliding knob).
//
// A semantic switch: a `<button role="switch" aria-checked>` rather than a
// styled checkbox, so it is keyboard- and screen-reader-correct by
// construction. Visuals are token-only (no hex). The knob slides and the
// track recolours on a `--duration-fast` transition; reduced-motion zeroes it
// globally (tokens.css).
//
// Interactivity follows `onChange` + `disabled`: omit `onChange` (or pass
// `disabled`) to render the dimmed, non-interactive placeholder used for
// tracked-but-not-yet-wired settings (`aria-disabled=true`, `not-allowed`
// cursor). First lifted out of Settings → Privacy's screen-capture toggle.

import { type CSSProperties } from "react";

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

const TRACK_BASE_STYLE: CSSProperties = {
  position: "relative",
  width: 36,
  height: 20,
  background: "var(--paper-3)",
  border: "1px solid var(--line-2)",
  borderRadius: 10,
  padding: 0,
  flexShrink: 0,
  transition:
    "background var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)",
};

const TRACK_ON_OVERRIDE: CSSProperties = {
  background: "var(--accent)",
  border: "1px solid var(--accent-press)",
};

// The knob keeps a constant 18px footprint (16px content + 1px border, which
// stays present but turns transparent when on) and slides via `transform`
// rather than `left` — so the travel is a smooth GPU transform with no layout
// thrash and no size morph mid-slide. Off and on both sit flush against their
// side of the track (translateX 0 ↔ 16). The track inner width (34) minus the
// knob footprint (18) is the 16px travel.
const KNOB_OFF_STYLE: CSSProperties = {
  position: "absolute",
  left: 1,
  top: 1,
  width: 16,
  height: 16,
  background: "var(--paper)",
  border: "1px solid var(--line-3)",
  borderRadius: "50%",
  transform: "translateX(0)",
  transition:
    "transform var(--duration-base) var(--ease-standard), background var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)",
};

const KNOB_ON_STYLE: CSSProperties = {
  ...KNOB_OFF_STYLE,
  transform: "translateX(16px)",
  background: "var(--accent-on)",
  borderColor: "transparent",
};

export function Switch({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  ariaDescribedBy,
  testId,
}: SwitchProps) {
  const interactive = onChange !== undefined && !disabled;
  const trackStyle: CSSProperties = {
    ...TRACK_BASE_STYLE,
    ...(checked ? TRACK_ON_OVERRIDE : {}),
    cursor: interactive ? "pointer" : "not-allowed",
    opacity: interactive ? 1 : 0.5,
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={!interactive}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      data-testid={testId}
      onClick={interactive ? () => onChange(!checked) : undefined}
      disabled={!interactive}
      // Hover affordance: deepen the track border so the control answers "yes,
      // I'm live" on pointer-over (the design-canon hover, adapted for a toggle —
      // a bordered control reads its hover on the border, not a fill). Restored
      // to the resting border on leave; the transition rides TRACK_BASE_STYLE.
      onMouseEnter={
        interactive
          ? (e) => {
              e.currentTarget.style.borderColor = checked
                ? "var(--accent)"
                : "var(--line-3)";
            }
          : undefined
      }
      onMouseLeave={
        interactive
          ? (e) => {
              e.currentTarget.style.borderColor = checked
                ? "var(--accent-press)"
                : "var(--line-2)";
            }
          : undefined
      }
      style={trackStyle}
    >
      <span
        aria-hidden="true"
        style={checked ? KNOB_ON_STYLE : KNOB_OFF_STYLE}
      />
    </button>
  );
}
