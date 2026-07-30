// Operator-query ranking for the command palette (MYND-303/307, Slice A). A
// palette query that uses operators is parsed to a `FilterNode` and evaluated to
// an id-set by the shared Saved Views engine — which is UNORDERED. This module
// ranks that id-set into the `NoteSearchResult[]` the palette already renders:
// BM25 order for the free-text portion where present, recency for the rest. A
// plain (operator-free) query never reaches here — the palette keeps its exact
// BM25 `note_search` path, so the common case is byte-for-byte unchanged.

import {
  evaluateFilter,
  type FilterNode,
  type LeafResolvers,
} from "./queryEngine";
import type { NoteSearchResult } from "../types/note-search-result";

/** Match the backend's `NOTE_SEARCH_RESULT_CAP` (search_sync_core.rs) so an
 *  operator query returns the same bounded row count as a plain one. */
export const OPERATOR_SEARCH_RESULT_CAP = 50;

/**
 * The free text a `FilterNode` searches for, ignoring negated branches — the
 * ranking signal. `search`/`titleMatch` (bare terms, `content:`, `file:`) leaves
 * contribute their query; structural leaves (`tag:`/`path:`/`task:`/property)
 * contribute nothing, so a purely-structural query ranks by recency alone.
 */
export function collectRankText(node: FilterNode): string {
  const parts: string[] = [];
  const walk = (n: FilterNode, negated: boolean): void => {
    switch (n.kind) {
      case "search":
      case "titleMatch":
        if (!negated) parts.push(n.query);
        return;
      case "and":
      case "or":
        for (const c of n.children) walk(c, negated);
        return;
      case "not":
        walk(n.child, !negated);
        return;
      default:
        return; // hasTag / inFolder / hasTask / property / all — no rank text
    }
  };
  walk(node, false);
  return parts.join(" ").trim();
}

export type OperatorSearchDeps = {
  readonly liveIds: ReadonlySet<string>;
  readonly resolvers: LeafResolvers;
  /** BM25 full-text search — the ranking signal + title/matched_in source. */
  readonly search: (query: string) => Promise<NoteSearchResult[]>;
  readonly titleFor: (id: string) => string | null;
  readonly recencyFallback: (ids: string[]) => string[];
};

/**
 * Evaluate a parsed operator query to a ranked, capped `NoteSearchResult[]`.
 * Candidates the free-text BM25 pass surfaces keep their score/title/matched_in
 * and lead, in BM25 order; the remaining (structural-only) candidates follow by
 * recency with a neutral score. Rejections from the resolvers or the search pass
 * propagate to the caller's existing catch (which empties the list), matching
 * `runNoteSearch`'s never-throws contract.
 */
export async function runOperatorSearch(
  parsed: FilterNode,
  deps: OperatorSearchDeps,
): Promise<NoteSearchResult[]> {
  const ids = new Set(await evaluateFilter(parsed, deps.liveIds, deps.resolvers));
  if (ids.size === 0) return [];

  const out: NoteSearchResult[] = [];
  const seen = new Set<string>();
  const rankText = collectRankText(parsed);
  if (rankText !== "") {
    for (const hit of await deps.search(rankText)) {
      if (ids.has(hit.note_id) && !seen.has(hit.note_id)) {
        out.push(hit);
        seen.add(hit.note_id);
      }
    }
  }
  const rest = deps.recencyFallback([...ids].filter((id) => !seen.has(id)));
  for (const id of rest) {
    out.push({
      note_id: id,
      title: deps.titleFor(id) ?? "",
      score: 0,
      matched_in: { title: false, body: false },
      attachment_id: null,
    });
  }
  return out.slice(0, OPERATOR_SEARCH_RESULT_CAP);
}
