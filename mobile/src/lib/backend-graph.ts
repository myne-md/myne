// Build a NoteGraph from vault-indices edges. The single graph builder for both
// paths: the backend `all_edges` dump when available, else client-extracted
// edges (`clientEdges`) — both fold titles/targets with the Turkish-correct
// `foldSegment`, so the fallback resolves links identically to the backend.

import { foldSegment } from "../dialect/folderPath";
import { pushMap } from "./util";
import { extractWikilinks } from "./indices-extract";
import type { NoteGraph, GraphEdge } from "./wikilinks";
import type { WikilinkEdge } from "./vault-indices";

/** Client-extracted edge dump (same shape as the backend `all_edges`), for the
 *  no-Tauri / pre-sweep fallback. */
export function clientEdges(
  notes: readonly { id: string }[],
  bodies: Map<string, string>,
): [string, WikilinkEdge[]][] {
  return notes.map((n) => [n.id, extractWikilinks(bodies.get(n.id) ?? "")]);
}

export function buildGraphFromEdges(
  notes: readonly { id: string; title: string }[],
  allEdges: readonly [string, WikilinkEdge[]][],
): NoteGraph {
  const titleKeyToId = new Map<string, string>();
  for (const n of notes) {
    const key = n.title ? foldSegment(n.title) : "";
    if (key && !titleKeyToId.has(key)) titleKeyToId.set(key, n.id);
  }

  const forward = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const [source, es] of allEdges) {
    for (const e of es) {
      const toId = titleKeyToId.get(e.titleKey);
      if (!toId || toId === source) continue;
      const dk = `${source} ${toId}`;
      if (seen.has(dk)) continue;
      seen.add(dk);
      edges.push({ from: source, to: toId });
      pushMap(forward, source, toId);
      pushMap(backlinks, toId, source);
    }
  }

  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }

  const nodes = notes.map((n) => ({ id: n.id, title: n.title, degree: degree.get(n.id) ?? 0 }));
  return { nodes, edges, backlinks, forward };
}
