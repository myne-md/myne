// Mobile A6 auto-lock envelope — the effective (clamped) idle-lock timeout.
//
// Mirror of the desktop `src-tauri/src/auto_lock.rs::effective_auto_lock_secs`
// so the two clients agree on the always-on envelope (`threat-model.md` §7, the
// two-class prefs taxonomy): a sentinel or replayed "off"/`0` (or a negative)
// can NEVER disable the idle lock. `null`/absent → DEFAULT; anything below the
// floor → MIN; anything above the ceiling → CEILING. There is no "disabled"
// return value by construction.
//
// The constant VALUES mirror the desktop *code* constants (these are code, not
// synced `vault.prefs` fields): MIN 30 / DEFAULT 300 / CEILING 3600.

/** Floor — a sentinel/replayed "off" (`<= 0`) can never disable the lock. */
export const MIN_AUTO_LOCK_SECS = 30;
/** Default when the preference is unset (`null`). */
export const DEFAULT_AUTO_LOCK_SECS = 300;
/** Ceiling — an out-of-range huge value is clamped down. */
export const AUTO_LOCK_CEILING_SECS = 3600;

/**
 * The effective idle-lock timeout in seconds, always within
 * `[MIN_AUTO_LOCK_SECS, AUTO_LOCK_CEILING_SECS]` — never "disabled".
 *
 * Mirror of the desktop `effective_auto_lock_secs(Option<u32>)`:
 * `prefs_value.unwrap_or(DEFAULT).clamp(MIN, CEILING)`.
 */
export function effectiveMobileAutoLockSecs(secs: number | null): number {
  const v = secs ?? DEFAULT_AUTO_LOCK_SECS;
  return Math.min(Math.max(v, MIN_AUTO_LOCK_SECS), AUTO_LOCK_CEILING_SECS);
}
