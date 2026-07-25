// Accent-folding for the Settings search (MYND-536). The shared `fuzzyFilter`
// (editor host) already lowercases both query and haystacks, so it is
// case-insensitive — but it does NOT strip diacritics, so "görünüm" would not
// match a "gorunum" query. This fold decomposes to NFD and drops the combining
// marks, giving the accent-insensitivity the acceptance criteria require. Pure +
// allocation-cheap, so it is safe to run per keystroke over the whole index.

/**
 * Fold accents for insensitive matching: NFD-decompose, then remove combining
 * diacritical marks. Casing is intentionally left alone — `fuzzyFilter`
 * lowercases downstream — so this composes cleanly with it. Idempotent on
 * already-folded input.
 */
export function foldAccents(input: string): string {
  return input.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}
