import { useRef, type CSSProperties, type ReactNode } from "react";
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
//
// **A wired one is a radiogroup, not four divs** (myne#508). The segments were
// bare `div`s with an `onClick`: nothing announced them, nothing could focus
// them, and no test could address one except by its localized text. That last
// part is why the horizon picker's first tests were all source-text greps, and
// a source-text grep cannot fail when the handler is deleted. The presentational
// form keeps no roles, because a board that is not tappable should not tell a
// screen reader it is.
/** A presentational board, or a wired control. The two differ in more than one
 *  field, so they are two shapes rather than one shape with optional halves.
 *
 *  **The name is required on the wired form** (myne#508). It was optional for
 *  one review round, and because the wired form is the one that renders
 *  `role="radiogroup"`, every existing caller gained a grouping role with
 *  `aria-label={undefined}`: an announced group with no name, which is worse
 *  than the unannounced divs it replaced. A union makes `tsc` name each site
 *  instead of leaving it to whoever notices. */
type SegmentedProps = {
  options: string[];
  active?: number;
  style?: CSSProperties;
  /** Segments derive `${testIdPrefix}-${optionValues[i] ?? i}`. */
  testIdPrefix?: string;
  /** Stable per-option ids for the testid tail, so a spec does not have to
   *  address a segment by its translated label. Defaults to the index. */
  optionValues?: string[];
} & (
  | { onChange: (index: number) => void; ariaLabel: string }
  | { onChange?: undefined; ariaLabel?: undefined }
);

export function Segmented({
  options,
  active = 0,
  onChange,
  style,
  ariaLabel,
  testIdPrefix,
  optionValues,
}: SegmentedProps) {
  const wired = onChange !== undefined;
  // Held so an arrow key can move focus with the selection. Populated by the
  // segments' own refs rather than by a query, so it cannot go stale against a
  // re-render that changes the option set.
  const segmentRefs = useRef<Record<number, HTMLDivElement>>({});
  return (
    <div
      role={wired ? "radiogroup" : undefined}
      aria-label={wired ? ariaLabel : undefined}
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
          role={wired ? "radio" : undefined}
          aria-checked={wired ? i === active : undefined}
          // Roving tabindex: the GROUP is one tab stop, and the selected
          // segment is the one it lands on. Giving every segment `tabIndex={0}`
          // is what this had first, and it makes a four-option control four tab
          // stops, which is the shape `role="radiogroup"` promises it is not.
          // Announcing a role and then not honouring its keyboard model is
          // worse than the unannounced divs this replaced.
          tabIndex={wired ? (i === active ? 0 : -1) : undefined}
          ref={
            wired
              ? (el) => {
                  if (el !== null && i === active) segmentRefs.current[i] = el;
                }
              : undefined
          }
          onClick={onChange ? () => onChange(i) : undefined}
          onKeyDown={
            onChange
              ? (e) => {
                  // Enter and Space are what a radio answers to. Arrows are how
                  // a radiogroup is traversed, and in a radiogroup they SELECT
                  // as they move rather than only moving focus.
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onChange(i);
                    return;
                  }
                  const delta =
                    e.key === "ArrowRight" || e.key === "ArrowDown"
                      ? 1
                      : e.key === "ArrowLeft" || e.key === "ArrowUp"
                        ? -1
                        : 0;
                  if (delta === 0) return;
                  e.preventDefault();
                  // Wraps, which is the radiogroup convention: the set is a
                  // cycle rather than a list with ends to get stuck against.
                  const next = (i + delta + options.length) % options.length;
                  onChange(next);
                  segmentRefs.current[next]?.focus();
                }
              : undefined
          }
          data-testid={testIdPrefix ? `${testIdPrefix}-${optionValues?.[i] ?? i}` : undefined}
          data-active={wired && i === active ? "true" : undefined}
          style={{
            flex: 1,
            textAlign: "center",
            // 44px is what both platforms publish as the minimum, and padding
            // alone does not reach it: 11px either side of a 14px label at the
            // inherited 1.5 line-height measures 43px. `minHeight` states the
            // target instead of computing it, so it cannot drift with a
            // typography token.
            minHeight: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 12px",
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
