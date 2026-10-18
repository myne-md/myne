import {
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { PHRASE_CELL_COUNT } from "@myne/client-core/phrase-cells";
import { Icon } from "./Icon";

/**
 * Form controls.
 *
 * The SPECIMENS (`Field`, `PasswordField`, `PinDots`, `RecoveryGrid`,
 * `Checkbox`, `Switch`, `Segmented`, `MonoBox`) are UI-only: nothing in them is
 * interactive state-wise. `focused`, `filled`, `checked`, `value` etc. are
 * presentational props the screens set to reproduce a particular design state,
 * and geometry matches the design catalog.
 *
 * The REAL fields are the two sections further down (`MonoField`, `TextField`).
 * They hold state and call back, which is why a wired flow binds those and not
 * the specimens above: a specimen that draws a `value` cannot collect one.
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
    // `dir="ltr"`, and it is a correctness fix rather than typography
    // (myne-md/myne#468). The ORDER of the words is part of the secret,
    // `recovery-flow.md` §2.4 commits to never showing them again, and BIP-39's
    // checksum does not catch a permutation — so under an RTL locale a grid laid
    // out in the locale's direction hands the user a transcription whose
    // wrongness is undiscoverable until the phrase fails to open the vault. The
    // surrounding page stays in the locale's own direction.
    <div
      dir="ltr"
      data-testid="recovery-grid"
      style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 8 }}
    >
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
  /** Segments derive `${testIdPrefix}-${optionValues[i] ?? i}`.
   *
   * A HYPHEN, and the separator is load-bearing rather than a style choice:
   * `settings.reminders-horizon-picker-1` and `-7` are read by the reminders
   * flow tier. myne-md/myne#609 built its own `Segmented` with a dot and its
   * date-time flow test reads one, so the two spellings met at a merge; the
   * hyphen wins because it has the live consumers. */
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
          // `active < 0 ? 0` is the no-selection fallback, and it is only for
          // the tab stop. `resolveHorizonDays` clamps a stored 2, 4 or 6 into
          // range rather than snapping it onto the offered set, so `active` is
          // -1 and no segment is checked. Without the fallback every segment
          // took `tabIndex={-1}`: an announced radiogroup with zero tab stops,
          // which a pointer user never notices and a keyboard user cannot enter
          // at all. The convention is that the first radio takes the tab stop
          // when none is checked. `aria-checked` and `data-active` are
          // deliberately NOT given the same fallback, so the readout stays
          // honest about there being no selection.
          tabIndex={wired ? (i === (active < 0 ? 0 : active) ? 0 : -1) : undefined}
          // EVERY mounted segment, not only the active one. Recording only the
          // active segment made the arrow handler's `segmentRefs.current[next]`
          // a silent no-op by construction, since `next` is never the active
          // index: React commits the state change after the handler returns, so
          // the still-focused segment then flipped to `tabIndex={-1}` and
          // `aria-checked="false"` while selection moved elsewhere. The next
          // key press fired from that same stale element, recomputed the same
          // `next`, and rewrote the value it had already written. One step of
          // traversal per two presses, permanently, with assistive technology
          // reporting focus on an unselected radio.
          //
          // The `null` cleanup call DELETES the entry rather than ignoring it,
          // so the map cannot outlive a changed option set and hand `focus()` a
          // detached node.
          ref={
            wired
              ? (el) => {
                  if (el === null) delete segmentRefs.current[i];
                  else segmentRefs.current[i] = el;
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

// ── Real text fields ─────────────────────────────────────────────────────────
// Distinct from the presentational `Field` above (a gallery mock that renders a
// div): these are the real `<input>`s a wired flow binds. They live here so the
// flow does not hand-roll a field, and so the regex-ratchet counts them once,
// in `PRIMITIVE_DIRS` (myne-md/myne#788).
export function MonoField({
  value,
  onChange,
  placeholder,
  testId,
  inputMode,
  dir,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  testId: string;
  inputMode?: "url";
  /** Pin the field left-to-right where the content is frozen English (the
   *  recovery-phrase type-back), so an RTL locale does not put the caret on the
   *  opposite side from where the grid showed the word. */
  dir?: "ltr";
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 52,
        border: `1.5px solid ${focused ? "var(--accent)" : "var(--line-2)"}`,
        borderRadius: "var(--radius-2)",
        background: "var(--bg-1)",
        padding: "0 14px",
        boxShadow: focused ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent)" : "none",
      }}
    >
      <input
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        inputMode={inputMode}
        dir={dir}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        data-testid={testId}
        style={{
          flex: 1,
          minWidth: 0,
          border: "none",
          outline: "none",
          background: "transparent",
          padding: 0,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-md)",
          letterSpacing: "var(--tracking-wide)",
          color: "var(--fg-1)",
        }}
      />
    </div>
  );
}

/** The general single-line field: a controlled `<input>` inside the bordered
 *  envelope the specimens at the top of this file draw.
 *
 *  `MonoField` above is the mono-only special case of this one and stays,
 *  because the identity code and the phrase type-back pin `dir`, `inputMode` and
 *  letter-spacing in a way a general field should not.
 *
 *  This exists because `IdentityFlow` had grown three hand-rolled copies of one
 *  envelope, each re-deriving the border, the focus ring, the inner `<input>`'s
 *  `border: none / outline: none / background: transparent` reset and the token
 *  padding — and one of them a third border state the other two did not have.
 *  Three copies is how an app acquires three field designs, which is the thing
 *  `check-primitive-adoption.mjs` counts (myne-md/myne#788).
 *
 *  The reveal toggle on a password stays at the CALL SITE rather than becoming
 *  field state: `type` is a prop here, so the caller's `trailing` button owns the
 *  toggle, and the field itself stays stateless apart from focus.
 */
export function TextField({
  value,
  onChange,
  testId,
  label,
  type = "text",
  leading,
  trailing,
  filled = false,
  mono = false,
  masked = false,
  disabled = false,
  autoCapitalize = "none",
  autoComplete = "off",
  dir,
  onEnter,
  onBlur,
  onPaste,
  style,
  inputStyle,
}: {
  value: string;
  onChange: (value: string) => void;
  testId: string;
  /** The accessible name. Not optional, unlike on a field that renders its own
   *  visible `<label>`: every caller of this one is a bare input with no label
   *  of its own, so an omitted name is a field a screen reader cannot announce. */
  label: string;
  type?: "text" | "password";
  /** Rendered before the input (the phrase grid's `01` index). */
  leading?: ReactNode;
  /** Rendered after it (a reveal toggle). */
  trailing?: ReactNode;
  /** The stronger "has content" border the phrase grid draws, so a filled cell
   *  is distinguishable from an empty one at a glance. */
  filled?: boolean;
  mono?: boolean;
  /** Masked presentation: wide tracking, so bullets read as a mask rather than
   *  as text. Pair with `type="password"`. */
  masked?: boolean;
  disabled?: boolean;
  autoCapitalize?: string;
  autoComplete?: string;
  /** Pin the field left-to-right where its content is frozen English, so an RTL
   *  locale does not put the caret on the opposite side from where the grid
   *  showed the word. */
  dir?: "ltr";
  onEnter?: () => void;
  /** Called when the field loses focus, for a field that commits a draft. */
  onBlur?: () => void;
  onPaste?: (event: ClipboardEvent<HTMLInputElement>) => void;
  style?: CSSProperties;
  inputStyle?: CSSProperties;
}) {
  const [focused, setFocused] = useState(false);
  const border = focused ? "var(--accent)" : filled ? "var(--line-1)" : "var(--line-2)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: leading !== undefined || trailing !== undefined ? "var(--space-2)" : undefined,
        background: "var(--bg-1)",
        border: `1px solid ${border}`,
        borderRadius: "var(--radius-2)",
        padding: "0 var(--space-3)",
        ...style,
      }}
    >
      {leading}
      <input
        type={type}
        value={value}
        data-testid={testId}
        aria-label={label}
        disabled={disabled}
        dir={dir}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onKeyDown={
          onEnter === undefined
            ? undefined
            : (e) => {
                if (e.key === "Enter") onEnter();
              }
        }
        onPaste={onPaste}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onBlur?.();
        }}
        autoCapitalize={autoCapitalize}
        autoComplete={autoComplete}
        spellCheck={false}
        style={{
          flex: 1,
          minWidth: 0,
          border: "none",
          outline: "none",
          background: "transparent",
          padding: "var(--space-3) var(--space-1)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
          fontSize: "var(--text-base)",
          letterSpacing: masked ? "var(--tracking-caps)" : undefined,
          color: "var(--fg-1)",
          ...inputStyle,
        }}
      />
      {trailing}
    </div>
  );
}

/** A read-only monospace value in a field (the identity code on the home step).
 *  The code is a few kilobytes of hex (`MYNE-PERSON-1:` + the public halves), so
 *  it renders in a single-line read-only input that scrolls, exactly as the
 *  desktop `IdentityHome` shows it. A wrapping box turns it into an unreadable
 *  wall and pushes everything below it off screen. */
export function MonoBox({ value, testId }: { value: string; testId: string }) {
  return (
    <input
      readOnly
      value={value}
      data-testid={testId}
      aria-label={testId}
      style={{
        display: "block",
        width: "100%",
        height: 52,
        border: "1.5px solid var(--line-2)",
        borderRadius: "var(--radius-2)",
        background: "var(--bg-1)",
        padding: "0 14px",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: "var(--fg-2)",
      }}
    />
  );
}

/** The `01` index a phrase cell renders before its input. */
const PHRASE_INDEX_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  flexShrink: 0,
};

/**
 * The 24-cell phrase ENTRY grid, shared by every mobile surface that takes a
 * phrase: device enrolment, vault recovery, the invite wizard's accept and join
 * steps, and the member-vault unlock.
 *
 * # One primitive, because the alternative was six
 *
 * `IdentityFlow` had already factored its own `PhraseCell`, and the other three
 * files each carried a copy of the same envelope: the grid template, the `01`
 * index, the paste-to-distribute arithmetic and the field reset. Six copies of
 * one credential surface is six chances for a phrase to be typed into a grid
 * that behaves differently from the one beside it, and `recovery-flow.md` §3.2
 * binds every surface rather than the recovery screen alone.
 *
 * # The anatomy
 *
 * A `TextField` per cell, which is where the field envelope already lives (its
 * own header records the three hand-rolled copies it replaced). The index is
 * `leading`, so it is a sibling of the input rather than inside it, and
 * `filled` draws the stronger border on a cell that has content.
 *
 * `dir="ltr"` on the GRID, and it is a correctness fix rather than typography
 * (myne-md/myne#468): the ORDER of the words is part of the secret,
 * `recovery-flow.md` §2.4 commits to never showing them again, and BIP-39's
 * checksum does not catch a permutation — so a grid laid out in an RTL locale's
 * direction hands the user a transcription whose wrongness is undiscoverable
 * until the phrase fails to open the vault.
 *
 * `minmax(0, 1fr)` rather than `1fr`: a `1fr` track is `minmax(auto, 1fr)`, and
 * that `auto` floor is the input's intrinsic width, which pushes the last column
 * off a narrow screen (the desktop equivalent is myne-md/myne#764).
 *
 * # What stays in the caller
 *
 * What a phrase is FOR — the submit gate, normalisation, the error banner, and
 * whether an edit clears one. `onCellEdited` exists for that last one, because
 * the copy this replaced each cleared its own error on the first keystroke.
 */
export function PhraseEntryGrid({
  cells,
  onCells,
  testIdPrefix,
  cellLabel,
  cellTestId,
  columns = 2,
  count = PHRASE_CELL_COUNT,
  labelledBy,
  disabled = false,
  onCellEdited,
  style,
}: {
  cells: readonly string[];
  onCells: (next: string[]) => void;
  /** Testid stem: grid `<stem>-grid`, cell `<stem>-cell` unless `cellTestId`. */
  testIdPrefix: string;
  /** The accessible name per cell. */
  cellLabel: (index: number) => string;
  /** Exact per-cell testid, for the callers whose first cell carries a bare name
   *  and the rest a `-cell-N` suffix. */
  cellTestId?: (index: number) => string;
  columns?: number;
  count?: number;
  /** The id of the element that names the group, when the caller renders one. */
  labelledBy?: string;
  disabled?: boolean;
  onCellEdited?: () => void;
  /** Merged onto the grid element, for the per-screen top margin the callers
   *  each had. */
  style?: CSSProperties;
}) {
  const setCell = (index: number, value: string): void => {
    onCellEdited?.();
    const next = [...cells];
    next[index] = value;
    onCells(next);
  };
  const paste = (index: number, event: ClipboardEvent<HTMLInputElement>): void => {
    // §3.2 paste-to-distribute: a phrase kept as one string in a password
    // manager is the common case, and asking the user to split it by hand is 24
    // chances to put a word in the wrong cell.
    const tokens = event.clipboardData
      .getData("text")
      .split(/\s+/)
      .filter((token) => token.length > 0);
    if (tokens.length < 2) return;
    event.preventDefault();
    onCellEdited?.();
    const next = [...cells];
    for (let i = 0; i < tokens.length && index + i < count; i += 1) {
      next[index + i] = tokens[i];
    }
    onCells(next);
  };
  return (
    <div
      dir="ltr"
      role="group"
      aria-labelledby={labelledBy}
      data-testid={`${testIdPrefix}-grid`}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: "var(--space-2)",
        ...style,
      }}
    >
      {Array.from({ length: count }, (_, index) => {
        const word = cells[index] ?? "";
        return (
          <TextField
            key={index}
            value={word}
            onChange={(value) => setCell(index, value)}
            onPaste={(event) => paste(index, event)}
            testId={cellTestId ? cellTestId(index) : `${testIdPrefix}-cell`}
            label={cellLabel(index)}
            filled={word.trim() !== ""}
            mono
            disabled={disabled}
            leading={
              <span aria-hidden="true" style={PHRASE_INDEX_STYLE}>
                {String(index + 1).padStart(2, "0")}
              </span>
            }
          />
        );
      })}
    </div>
  );
}
