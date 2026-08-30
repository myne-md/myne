import { useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";

/**
 * Form controls. UI-only: nothing is interactive state-wise — `focused`,
 * `filled`, `checked`, `value` etc. are presentational props the screens set to
 * reproduce a particular design state. Geometry matches the design catalog.
 */

// ── Text field ───────────────────────────────────────────────────────────────
export function Field({
  value,
  placeholder,
  focused = false,
  error = false,
  mono = false,
  trailing,
  style,
}: {
  value?: ReactNode;
  placeholder?: string;
  focused?: boolean;
  error?: boolean;
  mono?: boolean;
  trailing?: ReactNode;
  style?: CSSProperties;
}) {
  const borderColor = error ? "var(--danger)" : focused ? "var(--accent)" : "var(--line-2)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 52,
        border: `${focused || error ? 1.5 : 1}px solid ${borderColor}`,
        borderRadius: 6,
        background: "var(--bg-1)",
        padding: "0 14px",
        boxShadow: focused ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent)" : "none",
        ...style,
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
          fontSize: 16,
          color: value ? "var(--fg-1)" : "var(--line-3)",
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        {value ?? placeholder}
      </div>
      {trailing}
    </div>
  );
}

// ── Password field (masked monospace + caret + eye) ──────────────────────────
export function PasswordField({
  length = 12,
  focused = true,
  caret = true,
  revealed = false,
  value = "correct horse",
  style,
}: {
  length?: number;
  focused?: boolean;
  caret?: boolean;
  revealed?: boolean;
  value?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 52,
        border: `${focused ? 1.5 : 1}px solid ${focused ? "var(--accent)" : "var(--line-2)"}`,
        borderRadius: 6,
        background: "var(--bg-1)",
        padding: "0 14px",
        boxShadow: focused ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent)" : "none",
        ...style,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: revealed ? 16 : 14,
          letterSpacing: revealed ? "0" : "0.14em",
          color: "var(--fg-1)",
        }}
      >
        {revealed ? value : "•".repeat(length)}
      </span>
      {caret && <span style={{ width: 2, height: 24, background: "var(--accent)", marginInlineStart: 3 }} />}
      <div style={{ flex: 1 }} />
      <Icon name={revealed ? "eye-off" : "eye"} size={20} color="var(--fg-3)" strokeWidth={1.6} />
    </div>
  );
}

// ── Password-strength meter ──────────────────────────────────────────────────
const STRENGTH = {
  Weak: { bars: 1, color: "var(--danger)" },
  Fair: { bars: 2, color: "var(--warning)" },
  Good: { bars: 3, color: "var(--accent)" },
  Strong: { bars: 4, color: "var(--success)" },
} as const;

/** i18n key per strength level — the `level` prop stays the enum key into
 *  {@link STRENGTH}; only the displayed label is translated. */
const STRENGTH_LABEL_KEY: Record<keyof typeof STRENGTH, string> = {
  Weak: "settings.strength.weak",
  Fair: "settings.strength.fair",
  Good: "settings.strength.good",
  Strong: "settings.strength.strong",
};

export function StrengthMeter({ level = "Strong" }: { level?: keyof typeof STRENGTH }) {
  const { t } = useTranslation();
  const { bars, color } = STRENGTH[level];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ flex: 1, display: "flex", gap: 4 }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 999,
              background: i < bars ? color : "var(--line-1)",
            }}
          />
        ))}
      </div>
      <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-2)" }}>{t(STRENGTH_LABEL_KEY[level])}</span>
    </div>
  );
}

// ── PIN dots ─────────────────────────────────────────────────────────────────
export function PinDots({ filled = 0, total = 6 }: { filled?: number; total?: number }) {
  return (
    <div style={{ display: "flex", gap: 14, justifyContent: "center" }}>
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          style={{
            width: 16,
            height: 16,
            borderRadius: "50%",
            border: i < filled ? "none" : "1.5px solid var(--line-2)",
            background: i < filled ? "var(--accent)" : "transparent",
          }}
        />
      ))}
    </div>
  );
}

// ── 24-word recovery grid ────────────────────────────────────────────────────
export function RecoveryGrid({
  words,
  columns = 2,
  blurred = false,
}: {
  words: string[];
  columns?: number;
  blurred?: boolean;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 8 }}>
      {words.map((w, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 9,
            background: "var(--bg-2)",
            border: "1px solid var(--line-1)",
            borderRadius: 6,
            padding: "9px 11px",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--line-3)",
              width: 16,
              textAlign: "end",
              flexShrink: 0,
            }}
          >
            {i + 1}
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              fontWeight: 500,
              color: "var(--fg-1)",
              filter: blurred ? "blur(5px)" : "none",
            }}
          >
            {w}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Checkbox ─────────────────────────────────────────────────────────────────
export function Checkbox({ checked = false }: { checked?: boolean }) {
  return (
    <div
      style={{
        width: 22,
        height: 22,
        borderRadius: 4,
        flexShrink: 0,
        border: checked ? "none" : "1.5px solid var(--line-2)",
        background: checked ? "var(--accent)" : "var(--bg-1)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {checked && <Icon name="check" size={14} color="var(--accent-on)" strokeWidth={2.4} />}
    </div>
  );
}

// ── Switch (iOS toggle) ──────────────────────────────────────────────────────
// Presentational by default (gallery boards pass only `on`); pass `onToggle` to
// make it an interactive control (wired settings).
export function Switch({
  on = false,
  onToggle,
  disabled = false,
}: {
  on?: boolean;
  onToggle?: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      role={onToggle ? "switch" : undefined}
      aria-checked={onToggle ? on : undefined}
      aria-disabled={disabled || undefined}
      onClick={onToggle && !disabled ? onToggle : undefined}
      style={{
        width: 51,
        height: 31,
        borderRadius: 999,
        background: on ? "var(--success)" : "var(--line-2)",
        position: "relative",
        flexShrink: 0,
        cursor: onToggle && !disabled ? "pointer" : "default",
        opacity: disabled ? 0.5 : 1,
        transition: "background var(--duration-fast) var(--ease-standard)",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 2,
          // Logical inset so the knob rests on the inline-start when off and
          // slides to the inline-end when on — mirrored under RTL.
          insetInlineStart: on ? 22 : 2,
          width: 27,
          height: 27,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
          transition: "inset-inline-start var(--duration-fast) var(--ease-standard)",
        }}
      />
    </div>
  );
}

// ── Segmented control ────────────────────────────────────────────────────────
// Presentational by default (gallery boards pass only `active`); pass `onChange`
// to make each segment tappable (wired settings).
export function Segmented({
  options,
  active = 0,
  onChange,
  style,
  label,
  testId,
  optionIds,
}: {
  options: string[];
  active?: number;
  onChange?: (index: number) => void;
  style?: CSSProperties;
  /** Accessible name for the group. A segmented control with none is a row of
   *  words to a screen reader, with nothing saying what the choice is about. */
  label?: string;
  /** Testid for the group; each segment gets `<testId>.<optionId or index>`.
   *  Added with myne-md/myne#609, whose date and time rows were the first
   *  settings block in this sheet to ship with none while twelve siblings had
   *  them. */
  testId?: string;
  optionIds?: readonly string[];
}) {
  // `radiogroup` plus `radio`, which is what this IS: one choice out of a small
  // closed set. Before myne-md/myne#609 every segment was a bare `div` with an
  // `onClick`, so the control had no role, could not be reached by keyboard at
  // all, and announced nothing about which option was current. That is a
  // pre-existing gap rather than one this issue introduced, fixed here because
  // the issue added two more dependents to it.
  const pick = (i: number) => (): void => onChange?.(i);
  // ARROW KEYS, and they are not decoration. The roving `tabIndex` below makes
  // only the SELECTED segment focusable, which is the standard radiogroup
  // pattern and is unusable without them: Tab reaches the current choice, Enter
  // re-picks the choice already made, and no key reaches any other. The first
  // version shipped the roles and the roving index and no arrow handler, so the
  // control announced itself as an operable radiogroup while being inoperable,
  // which is worse than the un-roled `div` it replaced (myne-md/myne#609, found
  // in review). Wrapping is what a radiogroup does; `dir` is not consulted
  // because the visual order follows the DOM order under `flex` either way.
  const ref = useRef<HTMLDivElement | null>(null);
  const move = (i: number, delta: number) => (): void => {
    if (onChange === undefined || options.length === 0) return;
    const next = (i + delta + options.length) % options.length;
    onChange(next);
    // Focus follows selection, which is what makes the next arrow key continue
    // from where the reader is rather than from where they started.
    const el = ref.current?.children[next];
    if (el instanceof HTMLElement) el.focus();
  };
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      style={{
        display: "flex",
        padding: 2,
        background: "var(--bg-2)",
        borderRadius: 8,
        border: "1px solid var(--line-1)",
        gap: 2,
        ...style,
      }}
    >
      {options.map((o, i) => (
        <div
          key={o}
          role="radio"
          aria-checked={i === active}
          tabIndex={onChange ? (i === active ? 0 : -1) : undefined}
          data-testid={testId === undefined ? undefined : `${testId}.${optionIds?.[i] ?? i}`}
          onClick={onChange ? pick(i) : undefined}
          onKeyDown={
            onChange
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onChange(i);
                  } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                    e.preventDefault();
                    move(i, 1)();
                  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                    e.preventDefault();
                    move(i, -1)();
                  }
                }
              : undefined
          }
          style={{
            flex: 1,
            // Without it a long label refuses to shrink below its content and
            // pushes the row past the card. Five options at 358 px is where that
            // starts to matter, which is why it arrives with #609.
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textAlign: "center",
            padding: "7px 12px",
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 600,
            cursor: onChange ? "pointer" : "default",
            background: i === active ? "var(--accent)" : "transparent",
            color: i === active ? "var(--accent-on)" : "var(--fg-2)",
          }}
        >
          {o}
        </div>
      ))}
    </div>
  );
}
