// Circular CSS-only spinner for the EncryptingStep + AccountStep "Saving…"
// inline state. Animation lives in tokens.css (`@keyframes myne-spinner-rotate`).
//
// Under `prefers-reduced-motion: reduce` it keeps turning at HALF SPEED, not
// frozen: `tokens.css`'s blanket `animation-duration: 0ms` carves `.myne-spinner`
// out (MYND-630), on the reasoning that a spinner stopped mid-arc reads as hung
// rather than as calm.
//
// The small inline marks that used to live beside it are gone (myne-md/myne#603):
// the three-quarter arc, and the triangle that briefly replaced part of it.
// Both were hand-drawn geometry at 7 to 8px, and both were reported as unreadable
// by the person using them: an arc with a gap reads as a paused spinner, and a
// solid triangle at that size reads as a bullet. What replaced them is
// `<StatusMark>` below, which draws a NAMED icon at 12px. The argument the
// bespoke geometry rested on ("no Lucide pair distinguishes a filled dot from a
// hollow one at 7px") was true and answered the wrong question: the fix is not a
// better 7px glyph, it is not being at 7px.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./primitives/Icon";
import type { IconName } from "../lib/icons";

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
 * The size every inline status mark is drawn at.
 *
 * **One number, where there used to be two.** The 7px/8px pair existed to
 * optically compensate a hand-drawn ring: a bespoke shape at that scale needs a
 * different pixel count inside a text run than beside a title. A stroke icon
 * does not, because its weight comes from the stroke rather than from the
 * silhouette, so it reads the same in both places. 12 is also what the sidebar
 * row already draws its other icons at (`list`, `book-open`), so a mark now
 * matches its neighbours instead of being the one glyph with private sizing.
 *
 * It is deliberately BELOW the 16px icon floor in `docs/design/README.md`, and
 * that carve-out is the whole reason the inline-status-mark class exists: at 16
 * a glyph in a row's trailing slot reads as a badge attached to the note rather
 * than as a mark on it.
 */
const STATUS_MARK_PX = 12;

/**
 * A named icon standing in a text run to say what a surface owes
 * (myne-md/myne#566 for the class, myne-md/myne#603 for this shape of it).
 *
 * # Why an icon and not geometry
 *
 * The two glyphs this replaces were drawn from CSS borders at 7 to 8px, on the
 * reasoning that no Lucide pair distinguishes a filled dot from a hollow one at
 * that size. True, and the wrong conclusion: what followed was a three-quarter
 * ring that everybody read as a stalled spinner, and then a solid triangle that
 * read as a bullet point down a column of sidebar rows. Neither one could be
 * learned, because neither one depicted anything. A named icon at 12px depicts
 * the thing it means, and 12px is small enough that the badge problem the size
 * floor guards against does not arise.
 *
 * # Motion is a state, not a shape
 *
 * `spinning` wraps the icon in `.myne-spinner`, which supplies the rotation from
 * `tokens.css` and with it the MYND-630 reduced-motion carve-out (half speed
 * rather than frozen: a spinner stopped mid-turn reads as hung). Only ever true
 * for work that ENDS. `docs/design/README.md` bans looping animation, so a state
 * a user can sit in (text waiting on the autosave debounce, a note waiting for
 * a device that is offline) is always still.
 *
 * # Never a live region
 *
 * `role="img"` in every position. An `aria-live` region announces a CONTENT
 * change and this span has no text content, so `role="status"` on it announces
 * nothing; the earlier version of this component shipped exactly that and was
 * silent. A surface that needs the state spoken renders a persistently-mounted
 * `<ActionStatus visuallyHidden>` beside it, which is what `SaveStatus` does.
 * The sidebar renders none, because one live region per unsynced row, all
 * re-labelled at once when a push starts, is a storm nobody can mute.
 */
export function StatusMark({
  name,
  label,
  title,
  spinning = false,
  tone = "muted",
  testId,
  style,
}: {
  /** Which icon. The set is `editor/src/host/lib/icons.ts`; a mark that needs a
   *  glyph the set lacks adds it there rather than drawing one here. */
  name: IconName;
  /**
   * Accessible name. The shape alone is not a readout, and neither is the
   * MOTION: a state told only by rotation is told only to sighted users, so a
   * caller with two states passes two names.
   *
   * `null` says the mark is DECORATIVE because the same phrase is already
   * rendered as visible text beside it, and it renders `aria-hidden` instead.
   * Required rather than optional, so that stays a decision each caller makes:
   * an omitted prop would default the whole class back to silent, which is the
   * defect this component was written to end. `SaveStatus` draws the mark and
   * the words together, so a name here made a screen reader say the state
   * twice, once off the `role="img"` and once off the text.
   */
  label: string | null;
  /**
   * Hover text. NOT defaulted to `label`, deliberately: a mark usually sits
   * inside a span that already carries a longer sentence, and a default would
   * shadow it with a terser one for whichever pixel the pointer landed on.
   */
  title?: string;
  /** True only while work is actually in flight, and only for work that ends. */
  spinning?: boolean;
  /**
   * `accent` marks the one thing on the surface that is actually happening;
   * `muted` is everything merely outstanding. This is the sanctioned exception
   * to the canon's "never coloured independently" rule rather than a hole in it,
   * for exactly that reason.
   */
  tone?: "accent" | "muted";
  testId?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={spinning ? "myne-spinner" : undefined}
      // A constant hook, present in both forms. The tests used to find a mark by
      // its `role="img"`, which is the very thing a decorative mark drops, so
      // asserting the decorative shape would have meant losing the selector for
      // it. This separates finding the mark from what is being asserted about it.
      data-status-mark=""
      role={label === null ? undefined : "img"}
      aria-hidden={label === null ? true : undefined}
      aria-label={label ?? undefined}
      title={title}
      data-testid={testId}
      style={{
        display: "inline-flex",
        alignItems: "center",
        color: tone === "accent" ? "var(--accent)" : "var(--fg-3)",
        flexShrink: 0,
        ...style,
      }}
    >
      <Icon name={name} size={STATUS_MARK_PX} />
    </span>
  );
}
