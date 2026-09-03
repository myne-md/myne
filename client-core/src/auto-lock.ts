// The A6 auto-lock envelope, in TypeScript: the effective (clamped)
// idle-lock timeout a client's own WebView timer compares against.
//
// **A fourth copy of the same three numbers lived in `mobile/src/lib/` until
// myne-md/myne#479**, and it is the reason this file is here rather than there.
// The envelope now has one Rust home (`core/src/lib.rs`), and that home carries
// four `const _: () = assert!(…)` invariants that fail the BUILD if a future
// edit inverts the bounds or moves DEFAULT outside them. The TypeScript copy
// carried none. All three are marked PLACEHOLDER in the Rust, so the day
// MYND-122 settles them the asserts fire on the Rust side and a phone's timer
// silently keeps 3600. `tests/lib/autoLockEnvelope.test.ts`
// closes that by parsing the Rust and holding these to it.
//
// Why it belongs in `@myne/client-core` and the `vault-*` modules do not: this
// is a pure function of a number. Zero host contact, which IS the package's
// entry criterion (`scripts/check-platform-seam.mjs`'s `seam: null`).
//
// The semantics are `threat-model.md` §7's two-class prefs taxonomy: a sentinel
// or replayed "off" (`0`, or a negative) can NEVER disable the idle lock.
// `null`/absent → DEFAULT; below the floor → MIN; above the ceiling → CEILING.
// There is no "disabled" return value, by construction.

/**
 * Floor: a sentinel or replayed "off" (`<= 0`) can never disable the lock.
 *
 * A UX-comfort bound rather than a security edge: an attacker who SHORTENS the
 * timeout only causes more-frequent locking. Mirrors `MIN_AUTO_LOCK_SECS`.
 */
export const MIN_AUTO_LOCK_SECS = 30;

/** Default when the preference is unset. Mirrors `DEFAULT_AUTO_LOCK_SECS`. */
export const DEFAULT_AUTO_LOCK_SECS = 300;

/**
 * Ceiling: an out-of-range huge value is clamped down.
 *
 * The **load-bearing edge**: because it lives in code and not in the replayable
 * `vault.prefs` blob, a replayed / tampered value can only make auto-lock
 * stricter and never push it past, so an A4 disk attacker cannot widen the A6
 * exposure window (`threat-model.md` §7). Mirrors `AUTO_LOCK_CEILING_SECS`.
 */
export const AUTO_LOCK_CEILING_SECS = 3600;

/**
 * The effective idle-lock timeout in seconds, always within
 * `[MIN_AUTO_LOCK_SECS, AUTO_LOCK_CEILING_SECS]`, never "disabled".
 *
 * The TypeScript mirror of `myne_core::effective_auto_lock_secs`:
 * `prefs_value.unwrap_or(DEFAULT).clamp(MIN, CEILING)`.
 */
export function effectiveAutoLockSecs(secs: number | null): number {
  const v = secs ?? DEFAULT_AUTO_LOCK_SECS;
  return Math.min(Math.max(v, MIN_AUTO_LOCK_SECS), AUTO_LOCK_CEILING_SECS);
}
