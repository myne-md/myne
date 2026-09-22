// The WCAG 2.2 SC 2.5.8 pointer-target floor, as one spreadable style
// (myne-md/myne#728, task 11).
//
// It lived in `editor/src/host/lib/` for one review round, on the reasoning
// that both trees would need it and `editor/` may not import from `src/`. The
// review found that the named second consumer was not one: the task checkbox
// does live in that package, but it is sized in `task-row.css` and imports
// nothing from here, so the shared location was serving a consumer that did
// not exist while every real one sat in `src/`. Moved to where they all are,
// and the re-export shim deleted with it. If `editor/` ever does need the
// floor, this file moves back and the shim comes back with it - a smaller
// price than a comment asserting a relationship nothing holds it to.
//
// The criterion is 24 by 24 CSS pixels for anything a pointer must hit. Myne's
// chrome is dense on purpose, and the controls that breached it breached it
// independently: 16, 18, 20 and 22 pixels across the tab strip, the sidebar
// row affordances, the settings rail and the switcher. Raising each one in
// place would have been nine separate judgements nobody could later re-derive,
// which is why `--target-min` is a token in the canon and this is the one
// place that reads it.
//
// A MINIMUM, never a fixed size. A control already larger keeps its size, and
// the small ones grow to the floor without their neighbours being re-laid out
// around a new fixed box. `flexShrink: 0` is part of it: a 24px minimum inside
// a cramped flex row is not a minimum at all if the row is allowed to squeeze
// it back under the floor, which is the one way this can be applied and still
// fail.
//
// The two exceptions the criterion itself allows are NOT expressed here,
// deliberately. An INLINE target (a link inside a sentence) is exempt because
// enlarging it would break the line it sits in, and a control whose function
// is duplicated by a larger one on the same screen is exempt too. Both are
// judgements about a specific control, so a component that is genuinely
// exempt says so in a comment at its own call site rather than importing a
// flag from here that would make the exemption look mechanical.

import type { CSSProperties } from "react";

/** Spread onto any control a pointer must hit. */
export const MIN_TARGET: CSSProperties = {
  minWidth: "var(--target-min)",
  minHeight: "var(--target-min)",
  flexShrink: 0,
};
