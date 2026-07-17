// Pure tag-set combination — the shared set-algebra core lifted out of the
// desktop `tagFilter.ts` (tag-system #1 / MYND-46) so BOTH the query engine
// (`queryEngine.ts`, `and`/`or` composition) and the desktop tag-filter
// orchestration bind to ONE implementation (no fork, no drift). This module is
// deliberately pure: no IPC, no sidebar cache, no React — the impure tag-filter
// orchestration (`tagFilter`, `tagFilterRows`, …) stays in the desktop
// `src/notes/tagFilter.ts`, which re-exports these three symbols for its
// existing importers.

export type FilterMode = "and" | "or";

/** Default combination mode (TS-2): AND = "narrow to notes with ALL tags". */
export const DEFAULT_FILTER_MODE: FilterMode = "and";

/**
 * Pure set combination over per-tag id lists (each already subtree-inclusive +
 * trash-excluded by `byTag`). AND = intersection, OR = union.
 *
 * - 0 lists → `[]` (the 0-tag "no filter" identity, TS-2 — NOT all-notes).
 * - 1 list → that list (n=1 collapses to a single `byTag`).
 * - Raw set-algebra (TS-2): selecting a parent AND its descendant yields the
 *   descendant's set (a parent's subtree-inclusive set ⊇ its descendant's, so
 *   the intersection is the descendant); the union symmetrically collapses to
 *   the parent. No redundancy detection.
 *
 * Order: the first list's order is preserved (AND filters it; OR appends
 * first-seen ids from later lists).
 */
export function combineTagSets(
  idLists: ReadonlyArray<ReadonlyArray<string>>,
  mode: FilterMode,
): string[] {
  if (idLists.length === 0) return [];
  if (idLists.length === 1) return [...idLists[0]!];

  if (mode === "or") {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const list of idLists) {
      for (const id of list) {
        if (!seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
    }
    return out;
  }

  // AND: ids from the first list present in every other list.
  const others = idLists.slice(1).map((l) => new Set(l));
  return idLists[0]!.filter((id) => others.every((s) => s.has(id)));
}
