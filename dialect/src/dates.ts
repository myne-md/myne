// Date shapes shared across the dialect layer.
//
// `RFC3339_FULL_DATE` is the §3.6.4 property-type authority's full-date shape. It
// lived in `editor/host/notes/propertyTyping` until MYND-611 needed it here too:
// `editor` depends on `dialect`, never the reverse, so a consumer in this package
// cannot import it from there. Rather than declare a second copy — which is exactly
// the drift §3.6.4's "siblings consume, never redeclare" rule exists to prevent —
// the constant moved down to the layer both sides can reach, and propertyTyping
// re-exports it so its own consumers are unchanged.

/** RFC 3339 full-date (`YYYY-MM-DD`), whole-string-anchored. */
export const RFC3339_FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether `y-m-d` is a date that exists. The regex above only checks shape, so
 * `2026-02-31` passes it; callers that must not silently accept an impossible
 * date (task fields do not — a wrong due date is worse than an unparsed one)
 * check this as well.
 */
export function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
  );
}
