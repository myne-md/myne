// Auto-naming for inline drawings (#213 / MYND-634). An inline `![[Drawing N]]`
// embed references its sibling drawing note BY TITLE — the wikilink resolver is
// title-keyed — so each auto-created inline drawing needs a title unique among
// the vault's existing drawings, or the embed would resolve ambiguously.
//
// Pulled out of PaneView so it is unit-testable without the (heavy, runtime-only)
// editor host.

/** The minimal shape of a sidebar cache record this reader needs. */
export type DrawingTitleRecord = { title: string | null; kind?: string | null };

/**
 * The next unused `"Drawing N"` title, scanning the drawing notes already in the
 * cache and returning one past the highest N (so it never collides with an
 * existing drawing title). Non-`Drawing N` drawing titles are ignored — they
 * don't participate in the numbering.
 */
export function nextDrawingTitle(
  cache: Iterable<DrawingTitleRecord>,
): string {
  let max = 0;
  for (const rec of cache) {
    if (rec.kind !== "drawing" || rec.title === null) continue;
    const m = /^Drawing (\d+)$/.exec(rec.title.trim());
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return `Drawing ${max + 1}`;
}
