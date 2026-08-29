// The outer box every full-window stage centres its card in (myne-md/myne#565).
//
// # Why this is shared rather than copied
//
// Seven screens had written the same six declarations by hand, and they were
// wrong in the same way: `minHeight: 100vh`. `App.tsx` reserves a 38px
// window-drag strip above the stage and gives the rest to a `flex: 1 /
// minHeight: 0` column, so a 100vh child of that column is 38px taller than the
// box it sits in. No ancestor scrolls, so the extra height goes off the bottom of
// the window, and centring inside the over-tall box drops the card half that
// distance below the optical centre.
//
// Fixing it in the two screens where it had become visible would have left five
// copies of the defect behind, on the tallest surfaces in the tree: the create
// flow (including the 24-word recovery phrase and its confirm button), the
// 24-cell phrase-entry grid, the password reset, Welcome, and the blocking
// progress step. So the declarations move here and the screens spread them.
//
// # The contract this replaces `100vh` with
//
// An ancestor flex column with a definite height. Every consumer has one today,
// including the two that `App` does not switch to directly (`StorageLost` and
// `DeviceRevoked` are returned by `Editor` in its own place, so they inherit the
// same column). A future mount outside such a column gets auto height, and it
// fails quietly rather than loudly, which is why the requirement is written down
// here rather than left to be rediscovered a third time.

import type { CSSProperties } from "react";

/** Spread first, then override `background` and `padding` per screen. */
export const stageRootStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
