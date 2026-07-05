// The note-graph shape shared by the graph builder (`backend-graph.ts`) and its
// renderer (`WikiGraph`). Edges + folding now live in one place — the graph is
// built by `buildGraphFromEdges` over either the backend `all_edges` dump or
// client-extracted edges (`clientEdges`), both folding with `foldSegment`
// (Turkish-correct). The old client-only `buildNoteGraph`/`parseWikilinks`
// (weaker `[[…]]` grammar + `toLowerCase` fold) were removed.

export interface GraphNode {
  id: string;
  title: string;
  /** Total edges touching this node (in + out) — drives node sizing. */
  degree: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface NoteGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** noteId → ids of notes that link TO it (backlinks). */
  backlinks: Map<string, string[]>;
  /** noteId → ids of notes it links to (outgoing). */
  forward: Map<string, string[]>;
}
