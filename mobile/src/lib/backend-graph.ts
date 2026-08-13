// Project the SHARED graph model onto mobile's `NoteGraph` shape.
//
// This file used to answer "what does this link point at" itself — a flat
// `titleKey → first matching note` lookup that disagreed with desktop on
// path-form links, `.md` links and title collisions (myne-md/myne#199). That
// answer now comes from `buildGraphModel`, which resolves through the single
// `resolveWikilink`; all that is left here is the projection to the shape
// mobile's UI consumes (`degree` for node sizing, `backlinks`/`forward` for the
// in-editor link lists).
//
// Both edge sources still work: the backend `all_edges` dump when the index has
// been swept, else client-extracted edges (`clientEdges`) — and both now come
// out of the same shared extractor, so the fallback resolves identically.

import { buildGraphModel, type GraphModel } from "@myne/editor/host/notes/graphModel";
import type { ResolverNote } from "@myne/editor/host/notes/resolveWikilink";
import { pushMap } from "./util";
import { extractWikilinks } from "./indices-extract";
import type { NoteGraph, GraphEdge } from "./wikilinks";
import type { WikilinkEdge } from "./vault-indices";

/** Client-extracted edge dump (same shape as the backend `all_edges`), for the
 *  no-Tauri / pre-sweep fallback. */
export function clientEdges(
  notes: readonly ResolverNote[],
  bodies: Map<string, string>,
): [string, WikilinkEdge[]][] {
  return notes.map((n) => [n.noteUuid, extractWikilinks(bodies.get(n.noteUuid) ?? "")]);
}

/** The shared model plus mobile's projection of it, from one build. The Graph
 *  tab renders the MODEL (the shared canvas takes it directly); the in-editor
 *  link lists read the projection. Returning both keeps the O(N+E) build from
 *  running twice per note-set change. */
export function buildNoteGraphAndModel(
  notes: readonly ResolverNote[],
  allEdges: readonly [string, WikilinkEdge[]][],
): { graph: NoteGraph; model: GraphModel } {
  const model = buildGraphModel(allEdges, notes);
  return { graph: projectToNoteGraph(model), model };
}

export function buildGraphFromEdges(
  notes: readonly ResolverNote[],
  allEdges: readonly [string, WikilinkEdge[]][],
): NoteGraph {
  return projectToNoteGraph(buildGraphModel(allEdges, notes));
}

function projectToNoteGraph(model: GraphModel): NoteGraph {
  const forward = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();
  const degree = new Map<string, number>();
  const edges: GraphEdge[] = [];
  for (const e of model.edges) {
    edges.push({ from: e.source, to: e.target });
    pushMap(forward, e.source, e.target);
    pushMap(backlinks, e.target, e.source);
    // One resolved source→target pair counts once per endpoint, however many
    // occurrences collapsed into it (the model carries the count as `weight`).
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const nodes = model.nodes.map((n) => ({
    id: n.id,
    title: n.title ?? "",
    degree: degree.get(n.id) ?? 0,
  }));
  return { nodes, edges, backlinks, forward };
}
