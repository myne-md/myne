// Middle-ellipsis truncation for user-controlled names shown in the importer's
// "Needs attention" rows (#392).
//
// A flagged file or folder name can be arbitrarily long — the stress vault
// ships a ~10 000-character title — and the finished sentence the row displays
// ("Title \"…\" name is longer than Myne allows.") is assembled by i18n
// interpolation. CSS cannot know which span of that finished sentence came from
// the user, so a purely visual clamp would either overflow the modal (no wrap
// rule) or hide the trailing "…is longer than Myne allows." along with the
// name. Shorten the value at the data end instead, keeping a leading and a
// trailing run: those two ends are what a user matches against their own file,
// and the untruncated value stays available in the row's copyable input.
//
// Counts by code point (`Array.from`), not UTF-16 code unit, so an astral or
// multibyte name (the repo's `long-title-multibyte-over` fixture) is never cut
// through the middle of a surrogate pair.

const ELLIPSIS = "…";

/**
 * Return `value` unchanged when it is at most `max` code points; otherwise a
 * `head … tail` form whose total length (including the one-character ellipsis)
 * is `max`. `max` is clamped to at least 2 so there is always room for one end
 * plus the ellipsis.
 */
export function truncateMiddle(value: string, max = 64): string {
  const cps = Array.from(value);
  const cap = Math.max(2, Math.floor(max));
  if (cps.length <= cap) return value;
  const budget = cap - 1; // one code point spent on the ellipsis
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  const start = cps.slice(0, head).join("");
  const end = tail > 0 ? cps.slice(cps.length - tail).join("") : "";
  return start + ELLIPSIS + end;
}
