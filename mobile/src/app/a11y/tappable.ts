// A tappable row is a real control (myne-md/myne#728, task 16).
//
// Mobile's flows are built from `<div onClick=…>` rows. On a touchscreen that
// works perfectly, which is exactly why it survived: the row is tappable, it
// looks tappable, and every hand-test passes. To VoiceOver and TalkBack it is
// a piece of text. The screen reader does not announce it as actionable, its
// activation gesture does nothing on it, and an external keyboard cannot reach
// it at all, so the whole flow ends at the first row.
//
// The fix is mechanical and therefore belongs in one place rather than in
// twenty call sites: a role, a Tab stop, and the two keys a button must answer.
//
// NAMING. `role="button"` takes its accessible name FROM ITS CONTENTS, so a
// row with text in it needs no label and must not be given one: an
// `aria-label` would OVERRIDE the row's own text, which is usually richer
// (a title plus a snippet plus a date). `label` is for the icon-only case,
// where there is no text to name it with. Passing a label for a row that has
// text is the mistake this comment exists to prevent.
//
// SPACE, and why it is `preventDefault`ed. On a real `<button>` the browser
// suppresses the page scroll that Space would otherwise cause. A div with
// `role="button"` gets no such help, so without this the row activates AND
// the list jumps a screen.
//
// PROPAGATION, and why it stops here. A tappable is frequently the INNER
// control of a row whose outer element keeps its own `onClick` as a touch
// convenience (the note row, the views sheet), because the row is wider than
// its text and a touch client should not have dead padding. Without stopping
// here, one tap runs both handlers. On the note row that was not merely a
// double call: `useHold`'s `consumeHeldClick()` is ONE-SHOT, so after a
// long-press the inner handler consumed the flag and returned, the click
// bubbled, the outer call saw `false` and opened the note out from under the
// action sheet the long-press had just opened. Stopping propagation is also
// the honest semantic rather than a patch: this element is the control, and
// an ancestor that also handles the same gesture is a duplicate of it.

import type { KeyboardEvent, MouseEvent } from "react";

export interface TappableOptions {
  /** What a tap does. `undefined` means the row is not interactive today. */
  onActivate?: () => void;
  /**
   * Accessible name, for a control with no text of its own. Omit it whenever
   * the element HAS text: the role computes the name from contents, and a
   * label would replace a richer name with a poorer one.
   */
  label?: string;
  /** `aria-expanded`, for a row that discloses something. */
  expanded?: boolean;
  /** `aria-selected` is not valid on `button`; a chosen row reports pressed. */
  pressed?: boolean;
}

export interface TappableProps {
  role: "button";
  tabIndex: 0;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  "aria-pressed"?: boolean;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Spread onto a `div`/`span` that behaves as a button. Returns `null` when
 * `onActivate` is absent, so a conditionally-interactive row can spread
 * `...(tappable({ onActivate: maybe }) ?? {})` and carry NO role at all when
 * it is inert, rather than announcing a button that does nothing.
 */
export function tappable(options: TappableOptions): TappableProps | null {
  const { onActivate, label, expanded, pressed } = options;
  if (onActivate === undefined) return null;
  return {
    role: "button",
    tabIndex: 0,
    ...(label === undefined ? {} : { "aria-label": label }),
    ...(expanded === undefined ? {} : { "aria-expanded": expanded }),
    ...(pressed === undefined ? {} : { "aria-pressed": pressed }),
    onClick: (event) => {
      event.stopPropagation();
      onActivate();
    },
    onKeyDown: (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      // Space on a div scrolls the page; a real button's default is
      // suppressed for us and this one is not.
      event.preventDefault();
      event.stopPropagation();
      onActivate();
    },
  };
}
