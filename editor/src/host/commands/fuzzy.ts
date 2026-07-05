// Shared fuzzy-match scorer used by the slash menu (`src/editor/slash/`) and
// the command palette (`src/commands/`). Case-insensitive scoring:
//   exact match           → 1000
//   prefix match          → 500
//   word-boundary substr  → 200
//   any substring         → 100
//
// Pure function — no DOM, no editor state — so it can be re-used anywhere a
// "filter a list of labeled items against a free-text query" pattern is
// needed.

export type FuzzyCandidate<T> = {
  item: T;
  haystacks: readonly string[];
};

export type FuzzyMatch<T> = {
  item: T;
  score: number;
};

export function fuzzyFilter<T>(
  candidates: readonly FuzzyCandidate<T>[],
  query: string,
): FuzzyMatch<T>[] {
  const trimmed = query.trim();
  if (trimmed === "") {
    return candidates.map((c) => ({ item: c.item, score: 1 }));
  }
  const q = trimmed.toLowerCase();
  const out: FuzzyMatch<T>[] = [];
  for (const candidate of candidates) {
    let best = 0;
    for (const raw of candidate.haystacks) {
      const h = raw.toLowerCase();
      if (h === q) {
        best = Math.max(best, 1000);
      } else if (h.startsWith(q)) {
        best = Math.max(best, 500);
      } else {
        // Word-boundary substring: " " + q OR "-" + q OR "/" + q anywhere.
        const wordBoundary =
          h.includes(` ${q}`) || h.includes(`-${q}`) || h.includes(`/${q}`);
        if (wordBoundary) {
          best = Math.max(best, 200);
        } else if (h.includes(q)) {
          best = Math.max(best, 100);
        }
      }
    }
    if (best > 0) out.push({ item: candidate.item, score: best });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
