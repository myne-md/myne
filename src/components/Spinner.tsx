// Circular CSS-only spinner for the EncryptingStep + AccountStep "Saving…"
// inline state. Animation lives in tokens.css (`@keyframes myne-spinner-rotate`).
//
// Under `prefers-reduced-motion: reduce` it keeps turning at HALF SPEED, not
// frozen: `tokens.css`'s blanket `animation-duration: 0ms` carves `.myne-spinner`
// out (MYND-630), on the reasoning that a spinner stopped mid-arc reads as hung
// rather than as calm. This header used to claim the opposite, and the two
// statements sat in the same repo contradicting each other.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

interface SpinnerProps {
  size?: number;
  style?: CSSProperties;
}

export function Spinner({ size = 32, style }: SpinnerProps) {
  const { t } = useTranslation();
  const borderWidth = Math.max(2, Math.round(size / 12));
  return (
    <div
      className="myne-spinner"
      role="status"
      aria-label={t("common.spinner.loadingLabel")}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: `${borderWidth}px solid var(--line-1)`,
        borderTopColor: "var(--accent)",
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

/**
 * The small inline sibling of `<Spinner>`: a three-quarter arc that says whether
 * work is outstanding, and whether anything is currently moving on it
 * (myne-md/myne#566).
 *
 * # Why a second shape rather than a second colour
 *
 * The two places this replaces were both 6px circles: a pulsing dot beside the
 * save readout, and a hollow ring on an unsynced row in the sidebar. At that
 * size a filled dot and a hollow one are the same glyph, and a slow opacity
 * pulse does not read as "in progress" so much as "this is a dot". One grammar,
 * three states, told by SHAPE first:
 *
 *   - solid dot        → settled. Nothing is owed. (Callers keep their own dot.)
 *   - static arc       → outstanding, but nothing is moving on it right now.
 *                        An edit waiting for a device that is offline is exactly
 *                        this, and so is text waiting on the autosave debounce.
 *                        A spinner there would be a lie about work in flight,
 *                        and it would also be a LOOPING animation, which
 *                        `docs/design/README.md` bans outright.
 *   - rotating arc     → in flight, and bounded: a disk write, a push. Never a
 *                        state a user can sit in.
 *
 * The gap is what carries "incomplete" when the arc is standing still, which is
 * why this is three quarters of a ring and not a full one.
 *
 * # Motion
 *
 * `myne-spinner` supplies the rotation from `tokens.css`, and with it the
 * MYND-630 reduced-motion carve-out. An indicator that freezes reads as hung,
 * so it slows to half speed instead of stopping. Not applied when `spinning` is
 * false: a static arc must have no animation to slow down.
 *
 * # The canon
 *
 * The one member of the design canon's **inline status mark** class
 * (`docs/design/README.md`, "Inline status marks are a separate class from
 * icons"). That section was written for this glyph in myne-md/myne#520's
 * review, which found the implementation and the canon disagreeing on four
 * rules at once: size, colour, hand-rolled geometry, and the Lucide status set.
 * The canon now carries the carve-out and the argument for it, so a reader of
 * either side finds the same answer.
 *
 * # Never a live region
 *
 * The prop that made it one is gone.
 *
 * It used to take `announces`, which swapped `role="img"` for `role="status"`
 * where the arc was the only carrier of the state. That did not work and could
 * not: an `aria-live` region announces a CONTENT change, this span has no text
 * content (its only accessible name is `aria-label`), and the one caller that
 * opted in mounted it conditionally, so the region did not exist before the
 * change it was supposed to announce. A caller that needs the state spoken
 * renders a persistently-mounted `<ActionStatus visuallyHidden>` beside the
 * glyph, which is what `SaveStatus` does; that component's own comment explains
 * why a region removed from the accessibility tree announces nothing.
 */
/**
 * The two sizes the arc is drawn at, named rather than written as a literal at
 * each call site.
 *
 * They differ by a pixel and both call sites' comments claim the glyph is "one
 * fact seen twice", which read as a contradiction until it was measured: the
 * save readout's arc sits INSIDE a text run at the readout's font size, and the
 * sidebar's sits at row level beside a title. Optical size follows the text it
 * sits in, so the shape is shared and the pixel count is not. Naming them says
 * that out loud; two bare literals said the opposite.
 */
export const SYNC_ARC_INLINE_PX = 7;
export const SYNC_ARC_ROW_PX = 8;

export function SyncArc({
  size = SYNC_ARC_ROW_PX,
  spinning,
  label,
  title,
  testId,
  style,
}: {
  size?: number;
  /** True only while work is actually in flight. See the state table above. */
  spinning: boolean;
  /**
   * Accessible name. The shape alone is not a readout, and neither is the
   * MOTION: a state told only by rotation is told only to sighted users, so a
   * caller with two states passes two names.
   */
  label: string;
  /**
   * Hover text. NOT defaulted to `label`, deliberately: this glyph is 7 to 8px
   * and usually sits inside a span that already carries a longer `title`, so a
   * default would shadow that sentence with a terser one for whichever pixel the
   * pointer happened to land on. A caller wanting the same string in both passes
   * it twice, which is cheap and visible.
   */
  title?: string;
  testId?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={spinning ? "myne-spinner" : undefined}
      role="img"
      aria-label={label}
      title={title}
      data-testid={testId}
      style={{
        display: "inline-block",
        boxSizing: "border-box",
        width: size,
        height: size,
        borderRadius: "50%",
        // Hairline-plus: at the 7-8px this ships at, 1px vanishes against
        // `--fg-3` and 2px closes the gap that carries the "incomplete" reading.
        // There is no width token between the two, so this is a literal on
        // purpose.
        borderWidth: 1.5,
        borderStyle: "solid",
        // Three sides drawn, one left open: the gap is the "not finished" cue
        // that survives the arc standing still.
        borderColor: spinning ? "var(--accent)" : "var(--fg-3)",
        borderTopColor: "transparent",
        background: "transparent",
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
