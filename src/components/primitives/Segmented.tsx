// `<Segmented>` — a single-select segmented control (radiogroup) with a
// sliding selection thumb.
//
// Extracted from the hand-rolled theme control in `settings/AppearancePanel.tsx`
// so the editor-typography settings (and any future discrete-choice setting)
// share one accessible, animated control. Semantics: `role="radiogroup"` with
// `role="radio"` segments. The selection fill is a single absolutely-positioned
// pill that translates/resizes to the active segment (measured pre-paint via
// `useLayoutEffect`) so it glides between options; reduced-motion zeroes the
// transition globally (tokens.css).
//
// testids: the root carries `testId`; each segment carries `${testId}-${value}`
// plus `data-value` + `data-active` for E2E targeting and assertions.

import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { hoverSurface } from "./hoverSurface";

export interface SegmentedOption {
  /** The wire value (also the `data-value` and the `${testId}-${value}` tail). */
  value: string;
  /** The segment caption. */
  label: string;
}

interface SegmentedProps {
  options: readonly SegmentedOption[];
  /** The currently-selected value (must match one option's `value`). */
  value: string;
  onChange: (value: string) => void;
  /** Accessible group name. */
  ariaLabel: string;
  /** Id of the text explaining the group, for `aria-describedby`. `SettingRow`
   *  hands this to its `control` render function. */
  ariaDescribedBy?: string;
  /** Per-segment accessible name. Defaults to the segment's own label; supply
   *  this where the caption alone reads oddly out of context (the theme picker
   *  announces "Switch to the Dark theme", not "Dark"). */
  optionAriaLabel?: (option: SegmentedOption) => string;
  /** Root `data-testid`; segments derive `${testId}-${option.value}`. */
  testId?: string;
}

const SEGMENTED_STYLE: CSSProperties = {
  position: "relative",
  display: "inline-flex",
  flexDirection: "row",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  overflow: "hidden",
  alignSelf: "flex-start",
};

// Single sliding fill behind the segments; labels + dividers sit above it.
const THUMB_STYLE: CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  left: 0,
  // Selected segment reads as accent (the sliding fill behind the active label).
  background: "var(--accent)",
  zIndex: 0,
  pointerEvents: "none",
  transition:
    "transform var(--duration-base) var(--ease-standard), width var(--duration-base) var(--ease-standard)",
};

const SEGMENT_STYLE: CSSProperties = {
  position: "relative",
  zIndex: 1,
  border: 0,
  background: "transparent",
  padding: "6px 16px",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
  cursor: "pointer",
  minWidth: 72,
  transition:
    "color var(--duration-fast) var(--ease-standard), background var(--duration-fast) var(--ease-standard)",
};

const SEGMENT_SELECTED_STYLE: CSSProperties = {
  ...SEGMENT_STYLE,
  // On the accent thumb, the label switches to the on-accent ink for contrast.
  color: "var(--accent-on)",
};

const DIVIDER_STYLE: CSSProperties = {
  position: "relative",
  zIndex: 1,
  width: 1,
  background: "var(--line-2)",
  alignSelf: "stretch",
};

export function Segmented({
  options,
  value,
  onChange,
  ariaLabel,
  ariaDescribedBy,
  optionAriaLabel,
  testId,
}: SegmentedProps) {
  const segmentRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [thumb, setThumb] = useState<{ left: number; width: number }>({
    left: 0,
    width: 0,
  });

  // Measure the active segment's box pre-paint so the fill lands without a
  // first-render flash; re-measure whenever the selection (or option set) moves.
  useLayoutEffect(() => {
    const idx = options.findIndex((o) => o.value === value);
    const el = segmentRefs.current[idx];
    if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
  }, [value, options]);

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      data-testid={testId}
      style={SEGMENTED_STYLE}
    >
      <span
        aria-hidden="true"
        style={{ ...THUMB_STYLE, width: thumb.width, transform: `translateX(${thumb.left}px)` }}
      />
      {options.map((o, idx) => {
        const selected = o.value === value;
        return (
          <Fragment key={o.value}>
            {idx > 0 && <span aria-hidden="true" style={DIVIDER_STYLE} />}
            <button
              ref={(el) => {
                segmentRefs.current[idx] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={optionAriaLabel ? optionAriaLabel(o) : o.label}
              data-testid={testId ? `${testId}-${o.value}` : undefined}
              data-value={o.value}
              data-active={selected ? "true" : "false"}
              onClick={() => {
                if (!selected) onChange(o.value);
              }}
              // Only unselected segments take a hover fill — the selected one
              // already carries the sliding thumb behind it.
              {...(selected ? {} : hoverSurface())}
              style={selected ? SEGMENT_SELECTED_STYLE : SEGMENT_STYLE}
            >
              {o.label}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
