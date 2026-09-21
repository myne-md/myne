// The pure knowledge-graph model — the SINGLE answer, shared by every client,
// to "what is a node and what is an edge" (myne-md/myne#199).
//
// Everything here is host-free and IPC-free: raw edges in, resolved model out.
// The IPC that fetches those edges (`vault_indices_all_edges`, `forward`, …)
// stays in each client's own vault-indices wrapper, which re-exports this
// module so no call site had to move.
//
// It exists because the two clients used to answer the question twice.
// Mobile ran a regex extractor over the raw note body and a flat
// `titleKey → first match` lookup, so `[[Folder/Note]]` and `[[Note.md]]`
// produced NO edge, a title collision resolved to a DIFFERENT note than
// desktop picked, and `[[X]]` inside a code fence became a phantom edge.
// A wikilink that points at two different notes depending on which client is
// open is a correctness bug, not a styling difference — hence one module, and
// `graphModelContract.ts` beside it to keep it that way.
//
// Resolution runs through the one resolver (`resolveWikilink.ts`, §5.3);
// extraction runs off the one parse tree (`@myne/dialect`), which is what keeps
// frontmatter and code blocks structurally out.

import { foldSegment } from "@myne/dialect/folderPath";
import type { WikilinkRef, WikilinkTargetKind } from "@myne/dialect/types";
import {
  buildResolverIndex,
  parseTarget,
  resolveWikilink,
  type ResolverIndex,
  type ResolverNote,
  type WikilinkResolution,
} from "./resolveWikilink";

/**
 * Known attachment/media extensions. An `![[…]]` embed whose target ends
 * with one of these is a media embed (E2) — excluded from BOTH the note
 * graph and broken-links. A WHITELIST, not "any non-`.md`", so dotted
 * note titles (`[[2024.review]]`, `[[v0.1]]`) are NOT false-excluded.
 */
const MEDIA_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
  ".pdf",
  ".mp3",
  ".m4a",
  ".wav",
  ".ogg",
  ".mp4",
  ".webm",
  ".mov",
];

export function isMediaTarget(target: string): boolean {
  const lastSegment = target.split("/").pop() ?? target;
  const lower = lastSegment.toLowerCase();
  return MEDIA_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * One per-occurrence outbound wikilink edge — the TS mirror of the Rust
 * `WikilinkEdge` (serde camelCase both ways). Title-keyed (Model-2): no
 * resolved UUID; resolution runs TS-side at query time.
 */
export type WikilinkEdge = {
  target: string;
  targetKind: WikilinkTargetKind;
  /** Folded title-key of the target (§3.7.8 fold) — the backlink bucket
   *  key, computed here so Rust never folds (no Turkish divergence). */
  titleKey: string;
  anchor: string | null;
  blockId: string | null;
  alias: string | null;
  embed: boolean;
  byteStart: number;
  byteEnd: number;
};

/**
 * Build the per-occurrence edge list from a note's parsed wikilinks.
 * Classification: `![[image.png]]`-style attachment embeds are skipped
 * (E2 — not note edges, kept out of broken-links); `![[Note]]` note
 * embeds become edges flagged `embed`; anchors/aliases/byte ranges are
 * carried verbatim. self-links are kept (the UI filters them).
 */
export function extractWikilinkEdges(
  wikilinks: ReadonlyArray<WikilinkRef>,
): WikilinkEdge[] {
  const edges: WikilinkEdge[] = [];
  for (const w of wikilinks) {
    if (w.embed && isMediaTarget(w.target)) {
      continue; // attachment embed — owned by the future media pipeline
    }
    edges.push({
      target: w.target,
      targetKind: w.targetKind,
      // Fold the parsed title via the SAME parse the resolver uses, so the
      // bucket key matches a note's own folded title-key (single source).
      titleKey: foldSegment(parseTarget(w).title),
      anchor: w.heading,
      blockId: w.blockId,
      alias: w.alias,
      embed: w.embed,
      byteStart: w.byteRange.start,
      byteEnd: w.byteRange.end,
    });
  }
  return edges;
}

/** A note's outbound link with its resolution (resolved or broken). */
export type ForwardLink = {
  edge: WikilinkEdge;
  resolution: WikilinkResolution;
};

/** Reconstruct a `WikilinkRef` from a stored edge so the single resolver
 *  can resolve it (plain-B — exactly the render-time resolution path). */
export function edgeToRef(edge: WikilinkEdge): WikilinkRef {
  return {
    raw: `[[${edge.target}]]`,
    byteRange: { start: edge.byteStart, end: edge.byteEnd },
    embed: edge.embed,
    target: edge.target,
    targetKind: edge.targetKind,
    alias: edge.alias,
    heading: edge.anchor,
    blockId: edge.blockId,
  };
}

/**
 * Resolve a batch of raw edges against the resident note-set via the SINGLE
 * resolver (the render-time path) — the shared core of `forward()` and the
 * graph adapter's whole-vault build (so the bulk dump resolves identically to
 * the per-note query; no second resolver). Pure (no IPC).
 */
export function resolveEdges(
  edges: ReadonlyArray<WikilinkEdge>,
  notes: ReadonlyArray<ResolverNote>,
  index?: ResolverIndex,
): ForwardLink[] {
  return edges.map((edge) => ({
    edge,
    resolution: resolveWikilink(edgeToRef(edge), notes, index),
  }));
}

/**
 * What a graph node IS (myne-md/myne#727).
 *
 * OPTIONAL, and that is load-bearing rather than lazy: every notes-only builder
 * here (`buildGraphModel`, `inducedNeighborhood`, `subgraphModel`,
 * `isolatedModel`) keeps producing `{id,title}` byte-identically, so the
 * cross-client contract fixture and the pinned layout fingerprint are untouched
 * by the tag-node work. An absent `kind` means "note"; only a tag node carries
 * one, which makes `kind === "tag"` the single test every consumer needs.
 */
export type GraphNodeKind = "note" | "tag";

/** A graph node, one note, or (whole-vault view only) one tag. `title` is the
 *  render label (null = untitled). */
export type GraphNode = {
  id: string;
  title: string | null;
  kind?: GraphNodeKind;
};

/**
 * The prefix that makes a tag node's id unmistakably NOT a note UUID
 * (myne-md/myne#727). A UUID can never contain a colon, so no note id can
 * collide with a tag node's, and the whole "is this a note or a tag" question
 * is answerable from the id alone by every consumer, the renderer, the list,
 * the click handler and a test.
 */
export const TAG_NODE_ID_PREFIX = "tag:";

/** The node id for the tag whose folded key is `tagKey`. */
export function tagNodeId(tagKey: string): string {
  return `${TAG_NODE_ID_PREFIX}${tagKey}`;
}

/** The folded tag key a tag node id names, or `null` if `id` is not one. */
export function tagKeyFromNodeId(id: string): string | null {
  return id.startsWith(TAG_NODE_ID_PREFIX)
    ? id.slice(TAG_NODE_ID_PREFIX.length)
    : null;
}

/** One tag and the notes carrying it, the input {@link withTagNodes} needs to
 *  turn a tag into a node. `key` is the FOLDED tag key (the same form
 *  `vaultIndices.byTag` and the color-group evaluator compare against), and
 *  `display` is what the label shows after the `#`. */
export type TagMembership = {
  key: string;
  display: string;
  members: ReadonlySet<string>;
};

/**
 * Add one node per tag, with an edge from the tag node to each note carrying it
 * (myne-md/myne#727), the "a coloured tag in the middle with its notes around
 * it" shape. Pure, and a no-op when there are no tags, so the notes-only paths
 * are unaffected.
 *
 * The tag node's title is `#<display>` and its colour is not decided here: it
 * is a render-time layer exactly like every other colour, and the caller puts
 * the tag node's id into the same `nodeColors` map it paints notes from.
 *
 * Two bounds, both deliberate. A tag whose members are all absent from `model`
 * contributes NO node, an empty hub floating in space claims a cluster that is
 * not in this view. And members are sorted, so the edge list is byte-stable
 * across Set iteration order, which is what lets a test assert it.
 */
export function withTagNodes(
  model: GraphModel,
  tags: ReadonlyArray<TagMembership>,
): GraphModel {
  if (tags.length === 0) return model;
  const live = new Set(model.nodes.map((n) => n.id));
  const nodes: GraphNode[] = [...model.nodes];
  const edges: GraphEdge[] = [...model.edges];
  for (const tag of tags) {
    const members = [...tag.members].filter((id) => live.has(id)).sort();
    if (members.length === 0) continue;
    const id = tagNodeId(tag.key);
    nodes.push({ id, title: `#${tag.display}`, kind: "tag" });
    for (const member of members) {
      edges.push({ source: id, target: member, weight: 1 });
    }
  }
  return { nodes, edges };
}

/** A weighted directed graph edge: `weight` = how many resolved occurrences
 *  collapsed into this source→target pair. */
export type GraphEdge = { source: string; target: string; weight: number };

export type GraphModel = { nodes: GraphNode[]; edges: GraphEdge[] };

/** BFS direction for {@link inducedNeighborhood}. */
export type GraphDirection = "out" | "in" | "both";

/**
 * Build the whole-vault graph model from the bulk edge dump + the resident
 * note-set. Nodes = every live note (orphans appear as isolated nodes). Edges =
 * resolved cross-note references — plain/alias/anchor/blockref/embed all resolve
 * to the target NOTE (so an `![[Note]]` embed or `[[Note#h]]` anchor counts as
 * an edge, no false orphans). Broken links contribute no edge; self-loops are
 * dropped; per-occurrence duplicates collapse to one weighted edge. Pure.
 */
export function buildGraphModel(
  allEdges: ReadonlyArray<readonly [string, ReadonlyArray<WikilinkEdge>]>,
  notes: ReadonlyArray<ResolverNote>,
): GraphModel {
  const nodes: GraphNode[] = notes.map((n) => ({
    id: n.noteUuid,
    title: n.title,
  }));
  const live = new Set(notes.map((n) => n.noteUuid));
  // Build the resolver index ONCE for the whole dump: turns each link's
  // resolution from an O(notes) scan into an O(1) lookup, so the whole-vault
  // build is O(edges) instead of O(edges × notes) (SYNC-11 scale fix).
  const index = buildResolverIndex(notes);
  const weights = new Map<string, GraphEdge>();
  for (const [source, edges] of allEdges) {
    if (!live.has(source)) continue; // a dumped note not in the live set (trashed)
    for (const link of resolveEdges(edges, notes, index)) {
      if (link.resolution.status !== "resolved") continue; // broken → no edge
      const target = link.resolution.noteUuid;
      if (target === source) continue; // self-loop → not a graph edge
      const key = `${source}\u0000${target}`;
      const existing = weights.get(key);
      if (existing) existing.weight += 1;
      else weights.set(key, { source, target, weight: 1 });
    }
  }
  return { nodes, edges: [...weights.values()] };
}

/**
 * The induced neighborhood subgraph around `seed`: BFS up to `depth` hops along
 * edges in `direction`, then the INDUCED subgraph — ALL edges among the reached
 * node-set, not just the BFS-tree edges. The visual graph's value over a list is
 * structure (clusters, triangles), which lives in the induced (inter-neighbor)
 * edges (SYNC-9 grill-#5 precision). Pure.
 */
export function inducedNeighborhood(
  model: GraphModel,
  seed: string,
  depth: 1 | 2,
  direction: GraphDirection,
): GraphModel {
  const reached = new Set<string>([seed]);
  let frontier = new Set<string>([seed]);
  for (let hop = 0; hop < depth; hop += 1) {
    const next = new Set<string>();
    for (const edge of model.edges) {
      if (
        (direction === "out" || direction === "both") &&
        frontier.has(edge.source) &&
        !reached.has(edge.target)
      ) {
        next.add(edge.target);
      }
      if (
        (direction === "in" || direction === "both") &&
        frontier.has(edge.target) &&
        !reached.has(edge.source)
      ) {
        next.add(edge.source);
      }
    }
    for (const id of next) reached.add(id);
    frontier = next;
    if (frontier.size === 0) break;
  }
  return {
    nodes: model.nodes.filter((n) => reached.has(n.id)),
    edges: model.edges.filter(
      (e) => reached.has(e.source) && reached.has(e.target),
    ),
  };
}

/**
 * Induced subgraph over a node-id subset — keep the nodes in `keepIds` and ONLY
 * the edges among them (the tag-filter path: feed the tag's note-set to the one
 * renderer; "filters ARE the degradation mechanism", SYNC-16). Pure.
 */
export function subgraphModel(
  model: GraphModel,
  keepIds: ReadonlySet<string>,
): GraphModel {
  return {
    nodes: model.nodes.filter((n) => keepIds.has(n.id)),
    edges: model.edges.filter(
      (e) => keepIds.has(e.source) && keepIds.has(e.target),
    ),
  };
}

/**
 * A nodes-only model of the given isolated notes (the orphans-only view,
 * SYNC-13) — N isolated points, no edges, no force layout needed (the cheapest
 * graph view; works at any vault size from the degree-0 index query). Pure.
 */
export function isolatedModel(
  ids: ReadonlyArray<string>,
  notes: ReadonlyArray<ResolverNote>,
): GraphModel {
  const idSet = new Set(ids);
  return {
    nodes: notes
      .filter((n) => idSet.has(n.noteUuid))
      .map((n) => ({ id: n.noteUuid, title: n.title })),
    edges: [],
  };
}
