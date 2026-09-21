// Graph-data adapter (SYNC-9, knowledge-graph-ux / MYND-197). The IPC half of
// the graph: it fetches edges (the bulk dump / per-note `forward`/`backlinks`)
// and hands them to the SHARED, pure model builder in
// `@myne/editor/host/notes/graphModel` (#199), which both clients now use — so
// desktop and mobile derive the same nodes and edges from the same vault.
//
// The pure transform (`buildGraphModel`, `inducedNeighborhood`, `subgraphModel`,
// `isolatedModel`) lives there and is re-exported here, so every existing import
// site keeps working. Resolution reuses the SINGLE `resolveWikilink` (no second
// resolver, never Rust to_lowercase).

import {
  buildResolverIndex,
  type ResolverIndex,
  type ResolverNote,
} from "./resolveWikilink";
import {
  buildGraphModel,
  type GraphDirection,
  type GraphEdge,
  type GraphModel,
  type GraphNode,
} from "./graphModel";
import { backlinks, forward, vaultIndicesAllEdges } from "./vaultIndices";

export {
  buildGraphModel,
  inducedNeighborhood,
  isolatedModel,
  subgraphModel,
  tagKeyFromNodeId,
  tagNodeId,
  TAG_NODE_ID_PREFIX,
  withTagNodes,
  type GraphDirection,
  type GraphEdge,
  type GraphModel,
  type GraphNode,
  type GraphNodeKind,
  type TagMembership,
} from "./graphModel";

/**
 * Whole-vault graph for the graph-view panel — dump + build the ENTIRE vault,
 * no node cap (the whole vault must render at any size, per the graph rework).
 * The former `GRAPH_NODE_CAP` route-by-count is gone; scale is now handled by
 * the off-thread worker layout (build is O(E)) + the renderer's culling/LOD.
 * The Rust `vault_indices_all_edges` still applies a high defensive edge-ceiling
 * (`MAX_GRAPH_EDGES`) as a DoS backstop, not a render limit.
 */
export async function loadWholeVaultGraph(
  notes: ReadonlyArray<ResolverNote>,
): Promise<GraphModel> {
  const allEdges = await vaultIndicesAllEdges();
  return buildGraphModel(allEdges, notes);
}

/**
 * Build the subgraph of a (small) note-id subset — the tag-filter path that
 * works at ANY vault size: per-note `forward()` over the bounded subset (NOT
 * the whole-vault dump), keeping only edges WITHIN the subset. Resolves via the
 * single resolver. Used when filtering to a tag's notes.
 */
export async function loadSubgraphForNotes(
  subsetIds: ReadonlyArray<string>,
  notes: ReadonlyArray<ResolverNote>,
  index: ResolverIndex = buildResolverIndex(notes),
): Promise<GraphModel> {
  const keep = new Set(subsetIds);
  const nodes: GraphNode[] = notes
    .filter((n) => keep.has(n.noteUuid))
    .map((n) => ({ id: n.noteUuid, title: n.title }));
  const weights = new Map<string, GraphEdge>();
  for (const id of subsetIds) {
    for (const link of await forward(id, notes, index)) {
      if (link.resolution.status !== "resolved") continue;
      const target = link.resolution.noteUuid;
      if (target === id || !keep.has(target)) continue; // only within the subset
      const key = `${id} ${target}`;
      const existing = weights.get(key);
      if (existing) existing.weight += 1;
      else weights.set(key, { source: id, target, weight: 1 });
    }
  }
  return { nodes, edges: [...weights.values()] };
}

/**
 * The open-note neighborhood subgraph (local-graph #5 / MYND-199): BFS up to
 * `depth` hops from `seedId` via `forward()` (out) and `backlinks()` (in),
 * then the INDUCED subgraph over the reached node-set ({@link loadSubgraphForNotes}).
 * Per-note queries over the (small, degree-bounded) neighborhood — works at any
 * vault size, no whole-vault dump. `both` merges out + in (an untitled seed has
 * no inbound by title → outbound only).
 */
export async function loadNeighborhood(
  seedId: string,
  depth: 1 | 2,
  direction: GraphDirection,
  notes: ReadonlyArray<ResolverNote>,
): Promise<GraphModel> {
  // One index for the whole BFS + the final induced-subgraph build — every
  // per-node forward()/backlinks() resolves against it in O(1) (SYNC-9 scale).
  const index = buildResolverIndex(notes);
  const reached = new Set<string>([seedId]);
  let frontier: string[] = [seedId];
  for (let hop = 0; hop < depth; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      if (direction === "out" || direction === "both") {
        for (const link of await forward(id, notes, index)) {
          if (
            link.resolution.status === "resolved" &&
            !reached.has(link.resolution.noteUuid)
          ) {
            reached.add(link.resolution.noteUuid);
            next.push(link.resolution.noteUuid);
          }
        }
      }
      if (direction === "in" || direction === "both") {
        for (const group of await backlinks(id, notes, index)) {
          if (!reached.has(group.sourceUuid)) {
            reached.add(group.sourceUuid);
            next.push(group.sourceUuid);
          }
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return loadSubgraphForNotes([...reached], notes, index);
}
