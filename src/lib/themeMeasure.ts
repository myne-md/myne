// Measure-token vocabulary + the proportional clamp (deep-customization, myne#394).
//
// A custom theme may reshape density and rhythm — spacing, corner radius, type
// scale, weight, tracking — not only colour. What keeps that from producing an
// unusable window is a PROTECTIVE ENVELOPE in the same spirit as the auto-lock
// bounds (`src-tauri/src/auto_lock.rs`): whatever the theme asks for, the applied
// value stays within 0.5×–2× of the token's built-in default. A tampered or
// careless theme can make the app denser or airier; it cannot make it unusable.
//
// ONE ratio rule for every family is deliberate (`decisions.md` 2026-08-06 clause
// (d)). Per-family absolute bounds would mean a fresh decision, and a fresh
// maintenance burden, every time a token joins the vocabulary; a ratio inherits
// its bound from `tokens.css`, which is then the single source for both the
// shipped value and the limit.
//
// Out-of-range CLAMPS rather than rejects: a refused value silently leaves the
// built-in in place, which reads to the theme author as "my theme did nothing",
// while a clamped one reads as "not quite that far" — the honest signal.
//
// **Twin note.** `MEASURE_KEYS` mirrors `theme-validator/src/ornament.rs`'s
// `MEASURE_KEYS`. The Rust side decides whether a key is *recognized*; this side
// decides what value is *safe to paint*, because only the client knows each
// token's built-in default. Neither can be derived from the other at build time,
// so they are kept in step by review — add a token to both in the same change.

/** Lower bound of the clamp band, as a multiple of the built-in default. */
export const CLAMP_MIN_RATIO = 0.5;
/** Upper bound of the clamp band, as a multiple of the built-in default. */
export const CLAMP_MAX_RATIO = 2;

/**
 * The measure tokens a theme may supply, mirroring `src/styles/tokens.css`.
 * Colour tokens are deliberately absent — they carry no scalar magnitude and
 * their safety property is contrast, not size.
 */
export const MEASURE_KEYS: readonly string[] = [
  // Spacing scale
  "--space-0",
  "--space-1",
  "--space-2",
  "--space-3",
  "--space-4",
  "--space-5",
  "--space-6",
  "--space-7",
  "--space-8",
  "--space-9",
  // Corner radius
  "--radius-1",
  "--radius-2",
  "--radius-3",
  "--radius-pill",
  // Type scale
  "--text-xs",
  "--text-sm",
  "--text-base",
  "--text-md",
  "--text-lg",
  "--text-xl",
  "--text-2xl",
  "--text-3xl",
  "--text-4xl",
  // Weight
  "--weight-regular",
  "--weight-medium",
  "--weight-semibold",
  "--weight-bold",
  // Tracking
  "--tracking-tight",
  "--tracking-normal",
  "--tracking-wide",
  "--tracking-caps",
];

const MEASURE_SET = new Set(MEASURE_KEYS);

/** Is this token name one the clamp governs? */
export function isMeasureKey(key: string): boolean {
  return MEASURE_SET.has(key);
}

/** `12px` → `{ n: 12, unit: "px" }`; `400` → `{ n: 400, unit: "" }`; else `null`. */
function parseScalar(raw: string): { n: number; unit: string } | null {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? { n, unit: m[2].toLowerCase() } : null;
}

/**
 * Clamp a theme-supplied measure value against the token's built-in default.
 *
 * Returns the value to paint, or `null` when no bound can be established — in
 * which case the caller must skip the token rather than paint it unbounded,
 * which is the whole point of the envelope. `null` happens in three cases:
 *
 *   - the value is not a scalar (`thick`, empty),
 *   - the default is unreadable (missing token, `auto`),
 *   - the units differ. Cross-unit comparison has no honest answer — `1rem` is
 *     `16px` only by convention, and the root font size is itself themable — so
 *     a guess here would silently defeat the clamp it pretends to enforce.
 */
export function clampMeasure(value: string, fallback: string): string | null {
  const v = parseScalar(value);
  const d = parseScalar(fallback);
  if (!v || !d) return null;
  if (v.unit !== d.unit) return null;

  // A zero default gives a band of [0, 0]. Intentional: a zero gap stays zero.
  const lo = Math.min(d.n * CLAMP_MIN_RATIO, d.n * CLAMP_MAX_RATIO);
  const hi = Math.max(d.n * CLAMP_MIN_RATIO, d.n * CLAMP_MAX_RATIO);
  const clamped = Math.min(hi, Math.max(lo, v.n));
  // `Number`'s own formatting drops trailing zeros (8 rather than 8.0), which is
  // what a hand-written token would say.
  return `${clamped}${v.unit}`;
}

/** What {@link clampPalette} decided about a palette. */
export interface ClampedPalette {
  /** The entries to paint — non-measure keys verbatim, measure keys bounded. */
  applied: Record<string, string>;
  /** Measure keys dropped because no bound could be established. */
  skipped: string[];
}

/**
 * Split a palette into what may be painted and what must be skipped.
 *
 * Non-measure keys (colours, ornament selections) pass through untouched: they
 * carry no magnitude to bound, and their own guards run elsewhere — the value
 * allowlist host-side, the contrast gate at apply time, the ornament vocabulary
 * in `theme-validator`.
 */
export function clampPalette(
  palette: Readonly<Record<string, string>>,
  defaults: Readonly<Record<string, string>>,
): ClampedPalette {
  const applied: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(palette)) {
    if (!isMeasureKey(key)) {
      applied[key] = value;
      continue;
    }
    const bounded = clampMeasure(value, defaults[key] ?? "");
    if (bounded === null) skipped.push(key);
    else applied[key] = bounded;
  }
  return { applied, skipped };
}

/**
 * Read each measure token's built-in default off the root element.
 *
 * Must be called while **no** custom palette is painted — the caller clears
 * before applying, and that ordering is what makes the reading the built-in
 * value rather than the previous theme's. Reading rather than hardcoding is
 * deliberate: it cannot drift from `tokens.css`, and it follows the active
 * built-in theme for any token whose value differs per theme.
 */
export function readMeasureDefaults(root: Element): Record<string, string> {
  const computed = getComputedStyle(root);
  const out: Record<string, string> = {};
  for (const key of MEASURE_KEYS) {
    const raw = computed.getPropertyValue(key).trim();
    if (raw) out[key] = raw;
  }
  return out;
}
