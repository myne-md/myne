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
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Icon } from "./Icon";
import { hoverSurface } from "./hoverSurface";
import type { IconName } from "../../lib/icons";

export interface SegmentedOption {
  /** The wire value (also the `data-value` and the `${testId}-${value}` tail). */
  value: string;
  /** The segment caption. */
  label: string;
  /** Optional glyph before the caption. A segment whose two options are a
   *  picture and a list is found faster by its icons than by two short words,
   *  and the caption is what keeps it guessable, so this is additive rather
   *  than a replacement (myne-md/myne#727). */
  icon?: IconName;
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
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--space-1)",
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const segmentRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [thumb, setThumb] = useState<{ left: number; width: number }>({
    left: 0,
    width: 0,
  });

  const measure = () => {
    const idx = options.findIndex((o) => o.value === value);
    const el = segmentRefs.current[idx];
    if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
  };

  // Measure the active segment's box pre-paint so the fill lands without a
  // first-render flash; re-measure whenever the selection (or option set) moves.
  useLayoutEffect(measure, [value, options]);

  // …and re-measure when the BOX changes, which the layout effect cannot see.
  //
  // A caller whose container mounts HIDDEN measures 0: a pane that is not the
  // active tab, a collapsed sidebar, a modal that is mounted closed. Nothing
  // then re-runs the layout effect, because neither the value nor the option set
  // moved, so the thumb stays zero-width while the SELECTED label keeps
  // `--accent-on` (`#0b0b09` in the dark themes): the active segment renders
  // invisible, on a dark panel, with no error anywhere (myne-md/myne#727). The
  // same discipline as `useScrollEdges`: observe the element, fall back to the
  // window, and feature-detect `ResizeObserver` because it is absent in jsdom
  // and an unguarded constructor throws during render.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const ro =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(root);
    if (ro === null && typeof window !== "undefined") {
      window.addEventListener("resize", measure);
    }
    measure();
    return () => {
      ro?.disconnect();
      if (ro === null && typeof window !== "undefined") {
        window.removeEventListener("resize", measure);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, options]);

  return (
    <div
      ref={rootRef}
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
              {o.icon !== undefined && <Icon name={o.icon} size={12} />}
              {o.label}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
