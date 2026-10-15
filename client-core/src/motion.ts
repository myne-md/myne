// Motion tokens, readable from TypeScript (motion-system task 6, myne-md/myne#732).
//
// The problem this exists for: the Web Animations API takes a `duration` as a
// NUMBER of milliseconds and an `easing` as a real easing string, so
// `el.animate(frames, { duration: 260, easing: "cubic-bezier(...)" })` cannot
// reference `--duration-slow` the way a CSS `transition` can. Before this module,
// every imperative animation in the tree carried its own copy of a duration and a
// curve, which is how the mobile client ended up animating on Material and iOS
// sheet curves while the CSS around it used the canon's.
//
// So the token is READ from the declared sheet instead of copied. One source, two
// consumption styles: CSS uses `var(--duration-slow)`, and this reads the same
// custom property off `:root`.
//
// A read that finds nothing returns 0 ms and the CSS-initial easing rather than a
// plausible default. That is deliberate: a missing token should be a visibly
// instant, un-eased animation that somebody notices, not a wrong-but-reasonable
// one that ships.
//
// Which tokens exist is checked in two places, and the second one had to be
// widened for this module to be covered at all: `scripts/check-token-parity.mjs`
// collects declarations, `var(--x)` references and the `cssVar: "--x"` form, so a
// bare token NAME passed as a string was invisible to it until it learned to read
// these three readers' calls as references too. See that file's `tokensIn`.

/** The computed value of a motion custom property, trimmed. `""` when undeclared. */
export function motionToken(token: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

/**
 * True when the reader has asked the OS for less motion.
 *
 * The blanket reduction that suppresses every CSS transition
 * (`transition-duration: 0ms !important` in each client's shell) does NOT reach a
 * Web Animations call, because that API takes its duration as an argument and no
 * stylesheet can zero it. So the suppression is applied here, in the one place
 * that hands a duration to `el.animate`. Without it a reduced-motion user would
 * get instant CSS transitions and a full-length imperative one on the same
 * screen, which is the asymmetry the canon's "disables all transitions, in both
 * tiers" line promises it does not have.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A duration token as milliseconds, for a Web Animations `duration`.
 *
 * Accepts both `260ms` and `0.26s`, because a token may be written either way and
 * `parseFloat("0.26s")` is `0.26`, not `260`.
 *
 * Returns 0 under `prefers-reduced-motion`, which the API reads as "no animation",
 * matching what the same preference does to every CSS transition on the screen.
 */
export function motionDurationMs(token: string): number {
  if (prefersReducedMotion()) return 0;
  const raw = motionToken(token);
  if (raw === "") return 0;
  const value = Number.parseFloat(raw);
  if (Number.isNaN(value)) return 0;
  return raw.endsWith("s") && !raw.endsWith("ms") ? value * 1000 : value;
}

/**
 * An easing token as the easing string a Web Animations call expects. Returns the
 * empty string when undeclared, which the API treats as `linear`.
 */
export function motionEasing(token: string): string {
  return motionToken(token);
}
