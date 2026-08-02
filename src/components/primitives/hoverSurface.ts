// Hover-feedback for inline-styled interactive surfaces (MYND UX polish).
//
// The design canon's clickable-surface affordance: on pointer-over, deepen the
// background to the hover ramp (`--bg-3` / `--paper-3`) — no transform, no color
// shift — so every clickable chrome element *reads* as clickable. This is
// exactly `IconButton`'s pattern (transparent → --paper-3), extracted so the
// dozens of bare inline `<button style={{ background: "transparent" }}>` sites
// across the app can opt in with a single spread instead of each re-deriving the
// two handlers (or, as most did, omitting them and giving no hover feedback at
// all — the "I can't tell what's hoverable" complaint this closes).
//
// Why JS handlers and not a CSS `:hover` class: the app styles inline (no
// Tailwind / CSS modules, `src/CLAUDE.md`), and an inline `background` always
// beats a stylesheet `:hover` on specificity — so a class would silently lose to
// the element's own resting background. Mutating `e.currentTarget.style` is what
// composes with inline styles, and it is the established pattern.
//
// Pair with `HOVER_TRANSITION` in the element's own `style` for the smooth
// deepen (the global reduced-motion rule in `tokens.css` zeroes it for users who
// ask). Reset lands on `restBg` so a selected/active control keeps its resting
// fill after the pointer leaves.

import type { CSSProperties, MouseEvent } from "react";

/** Drop into an interactive element's `style` for a smooth hover deepen. Zeroed
 *  automatically under `prefers-reduced-motion` by the global rule in
 *  `tokens.css`. */
export const HOVER_TRANSITION: CSSProperties["transition"] =
  "background var(--duration-fast) var(--ease-standard)";

interface HoverSurfaceOpts {
  /** Background at rest / on pointer-leave. Default transparent — pass the
   *  control's resting fill (e.g. a selected tab's `var(--paper-3)`) so leaving
   *  restores it instead of clearing it. */
  restBg?: string;
  /** Background on pointer-over. Default `var(--bg-3)` — the canon hover ramp. */
  hoverBg?: string;
  /** Disabled control: no hover response (returns empty handlers). */
  disabled?: boolean;
}

/**
 * Spreadable `onMouseEnter` / `onMouseLeave` handlers that deepen an element's
 * background on hover and restore it on leave. Spread onto any inline-styled
 * `<button>` / clickable `<div>`:
 *
 *   <button style={{ background: "transparent", transition: HOVER_TRANSITION }}
 *           {...hoverSurface()}>…</button>
 *
 * The element keeps ownership of its resting `style.background`; these handlers
 * only mutate it transiently. When `disabled`, both handlers are no-ops so a
 * dimmed control never lights up.
 */
export function hoverSurface(opts: HoverSurfaceOpts = {}): {
  onMouseEnter?: (e: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (e: MouseEvent<HTMLElement>) => void;
} {
  const { restBg = "transparent", hoverBg = "var(--bg-3)", disabled = false } =
    opts;
  if (disabled) return {};
  return {
    onMouseEnter: (e) => {
      e.currentTarget.style.background = hoverBg;
    },
    onMouseLeave: (e) => {
      e.currentTarget.style.background = restBg;
    },
  };
}
