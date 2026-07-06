// Saved-view filter evaluation — the mobile counterpart to the desktop
// `src/notes/queryEngine.ts`. A `FilterNode` AST is resolved to a set of note
// ids by set algebra over injected leaf resolvers, every result intersected with
// the live-set gate. Byte-compatible with the persisted `FilterNode` (prefs), so
// a view authored on desktop runs here (except the `property` leaf — see below).

import type { FilterNode } from "./prefs";
import { foldSegment } from "../dialect/folderPath";

export interface QueryCtx {
  /** The live note ids (not trashed/archived/template/…). The gate. */
  liveIds: Set<string>;
  /** Note ids carrying a tag (folded key), subtree-inclusive. */
  tagMembers: (tag: string) => Iterable<string>;
  /** Note ids in a folder subtree (folded path). */
  folderMembers: (path: string) => Iterable<string>;
  /** Note ids matching a full-text query. */
  searchMembers: (query: string) => Iterable<string>;
}

function gated(ids: Iterable<string>, live: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) if (live.has(id)) out.add(id);
  return out;
}

/** Evaluate a filter AST to the matching live note ids. The `property` leaf is
 *  not supported on mobile v1 (needs the frontmatter property index) → it
 *  contributes the empty set. */
export function evaluateFilter(node: FilterNode, ctx: QueryCtx): Set<string> {
  switch (node.kind) {
    case "all":
      return new Set(ctx.liveIds);
    case "hasTag":
      return gated(ctx.tagMembers(foldSegment(node.tag)), ctx.liveIds);
    case "inFolder":
      return gated(ctx.folderMembers(node.path), ctx.liveIds);
    case "search":
      return gated(ctx.searchMembers(node.query), ctx.liveIds);
    case "property":
      return new Set<string>();
    case "not": {
      const child = evaluateFilter(node.child, ctx);
      const out = new Set<string>();
      for (const id of ctx.liveIds) if (!child.has(id)) out.add(id);
      return out;
    }
    case "and": {
      if (node.children.length === 0) return new Set(ctx.liveIds);
      let acc: Set<string> | null = null;
      for (const c of node.children) {
        const s = evaluateFilter(c, ctx);
        if (acc === null) {
          acc = s;
        } else {
          const next = new Set<string>();
          for (const id of acc) if (s.has(id)) next.add(id);
          acc = next;
        }
      }
      return acc ?? new Set(ctx.liveIds);
    }
    case "or": {
      const out = new Set<string>();
      for (const c of node.children) for (const id of evaluateFilter(c, ctx)) out.add(id);
      return out;
    }
    default:
      return new Set<string>();
  }
}
