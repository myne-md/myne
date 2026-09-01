// The one definition of "present to a screen reader, absent to the eye".
//
// It is a clipped 1x1 box rather than `display: none` or `visibility: hidden`,
// and the difference is the whole point: both of those remove the element from
// the accessibility tree, so a live region announces nothing and a focusable
// control becomes unreachable by the reader it exists for.
//
// Two consumers, and they need it for opposite reasons, which is why it is a
// shared constant rather than a local one in either:
//
// - `src/components/ActionStatus.tsx`. A live region that must be announced and
//   never drawn.
// - `src/components/ScreenCaptureEscape.tsx`. A skip-link control that must be
//   reachable by keyboard on a window a magnifier user sees as black, and drawn
//   the moment it takes focus (so it spreads this and then overrides it).
//
// `e2e/screen-capture-override.e2e.ts` asserts on the literal
// `clip-path: inset(50%)` string, so this constant is the one authority behind
// that assertion rather than one of two.

import type { CSSProperties } from "react";

export const VISUALLY_HIDDEN: CSSProperties = {
  width: 1,
  height: 1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};
