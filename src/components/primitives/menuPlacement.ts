// Which side of a trigger a portaled menu opens on, and how tall it may be
// (myne-md/myne#771).
//
// ── The failure it closes ──────────────────────────────────────────────────
// `<Select>` and `<SearchableSelect>` both anchored their menu at
// `top: rect.bottom + 4`, unconditionally. That is correct for a control in the
// middle of a settings panel and wrong for one near the bottom of the window —
// which is where the AI composer's two dropdowns now live, under the input, a
// few pixels above the status bar. The menu opened downward into nothing: a
// 280px panel showing two rows and the rest below the viewport, with no scroll
// to reach it because the menu is `position: fixed` and the page does not
// extend.
//
// It is not only the composer. Any Select in the last ~300px of the window had
// the same shape, and nothing reported it: the menu renders, the options exist
// in the DOM, every test that finds one by testid passes, and axe has no
// opinion about a control drawn past the fold.
//
// ── Why a shared helper rather than two fixes ──────────────────────────────
// The two components measure differently on purpose — one left-aligns, the
// other right-aligns so it cannot spill past the window edge — but "which side
// is there room on" is one question with one answer, and a rule this
// arithmetical is exactly the kind that drifts when it is written twice. What
// stays per-component is the horizontal half, which is genuinely different.
//
// ── The height is part of the answer, not a separate one ───────────────────
// Returning a side without a height would move the overflow rather than remove
// it: flipping a 320px menu above a trigger 200px from the top of the window
// runs off the TOP instead. So the room on the chosen side bounds the menu.
//
// **It bounds it — it does not set it**, and the first version of this got that
// backwards. An inline `max-height` OVERRIDES the stylesheet, so writing the
// available space there did not leave `components.css`'s 280/320px as a cap: it
// replaced it. On a tall window that is ~1200px of room above a trigger near
// the bottom, and a twenty-item folder list grew to fill nearly the whole
// screen — a dropdown the size of a page. The caller passes its own cap and
// the smaller of the two wins.

/** How much room a menu needs below before it is worth opening downward. */
const MIN_BELOW = 160;

/** Breathing room kept between the menu and the window edge. */
const EDGE = 8;

/** Gap between the trigger and the menu. */
const GAP = 4;

export interface MenuPlacement {
  /** Set when the menu opens DOWNWARD: its top edge, in viewport pixels. */
  top?: number;
  /** Set when the menu opens UPWARD: its bottom edge, as a CSS `bottom`. */
  bottom?: number;
  /** The ceiling for this side. Always set: it is what keeps either direction
   *  inside the window, and it overrides the stylesheet's own `max-height`. */
  maxHeight: number;
  /** Which way it opened, for a caller that wants to say so in the DOM. */
  side: "below" | "above";
}

/**
 * Place a portaled menu vertically against its trigger.
 *
 * `viewportHeight` is a parameter rather than a read of `window` so the rule is
 * testable without a browser: jsdom reports a fixed 768 and no layout, so a
 * test that could only drive the real global would be asserting a constant.
 */
export function placeMenu(
  triggerRect: { top: number; bottom: number },
  viewportHeight: number,
  opts: {
    /** The menu's own resting height — `components.css`'s `max-height` for
     *  this variant. The result never exceeds it, because the inline value
     *  written from this OVERRIDES that rule rather than deferring to it. */
    cap: number;
    /** How much room below is enough to open downward. Defaults to the cap,
     *  which is the honest threshold: "enough" means "enough for this menu". */
    minBelow?: number;
  },
): MenuPlacement {
  const { cap } = opts;
  const minBelow = opts.minBelow ?? Math.min(cap, MIN_BELOW);
  const below = viewportHeight - triggerRect.bottom - GAP - EDGE;
  const above = triggerRect.top - GAP - EDGE;

  // Downward unless there is genuinely not room AND upward is better. The
  // second half matters: in a short window both sides are cramped, and flipping
  // to the smaller one would be worse for no reason.
  if (below >= minBelow || below >= above) {
    return {
      top: triggerRect.bottom + GAP,
      maxHeight: Math.max(0, Math.min(cap, below)),
      side: "below",
    };
  }
  return {
    bottom: viewportHeight - triggerRect.top + GAP,
    maxHeight: Math.max(0, Math.min(cap, above)),
    side: "above",
  };
}
