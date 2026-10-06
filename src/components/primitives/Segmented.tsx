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
// Appearance lives in `@myne/client-core`'s `components.css` under
// `.myne-segmented` (myne-md/myne#773). What stays here is the part a
// stylesheet cannot do: MEASURING the active segment's box so the thumb knows
// where to travel. The hover rule moved to `[aria-checked="false"]:hover`, so
// the painted "not selected" and the announced "not selected" are now the same
// attribute rather than two things a call site keeps in step.
//
// testids: the root carries `testId`; each segment carries `${testId}-${value}`
// plus `data-value` + `data-active` for E2E targeting and assertions.

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "./Icon";
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
  /**
   * Density. `"md"` (default) is the settings-row size; `"sm"` is for a control
   * floating on content, where the cluster has to stay narrow enough not to
   * cover what it sits on.
   */
  size?: "sm" | "md";
}

export function Segmented({
  options,
  value,
  onChange,
  ariaLabel,
  ariaDescribedBy,
  optionAriaLabel,
  testId,
  size = "md",
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
      data-size={size}
      className="myne-segmented"
    >
      <span
        aria-hidden="true"
        className="myne-segmented__thumb"
        // The two measured values, and only those: a stylesheet cannot know how
        // wide the active segment is. Everything else about this element —
        // fill, stacking, the travel transition — is in `components.css`.
        style={{ width: thumb.width, transform: `translateX(${thumb.left}px)` }}
      />
      {options.map((o, idx) => {
        const selected = o.value === value;
        return (
          <Fragment key={o.value}>
            {idx > 0 && (
              <span aria-hidden="true" className="myne-segmented__divider" />
            )}
            <button
              ref={(el) => {
                segmentRefs.current[idx] = el;
              }}
              type="button"
              role="radio"
              className="myne-segmented__segment"
              aria-checked={selected}
              aria-label={optionAriaLabel ? optionAriaLabel(o) : o.label}
              data-testid={testId ? `${testId}-${o.value}` : undefined}
              data-value={o.value}
              data-active={selected ? "true" : "false"}
              onClick={() => {
                if (!selected) onChange(o.value);
              }}
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
