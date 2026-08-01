// The desktop half of the cross-client graph-model contract (myne-md/myne#199).
// Runs the shared fixture through the desktop extraction pipeline — parse →
// `extractWikilinkEdges` → `buildGraphModel` — and compares the summary against
// the one expected answer. `myne-mobile/tests/wikilinks.test.ts` runs the same
// fixture through its own pipeline; the two agreeing IS the parity guarantee.

import { describe, expect, it } from "vitest";
import { parse } from "@myne/dialect/parse";
import {
  buildGraphModel,
  extractWikilinkEdges,
  type WikilinkEdge,
} from "../../src/notes/graphModel";
import {
  GRAPH_CONTRACT_EXPECTATION,
  GRAPH_CONTRACT_NOTES,
  GRAPH_CONTRACT_RESOLVER_NOTES,
  summarizeGraphModel,
} from "@myne/editor/host/notes/graphModelContract";

/** The desktop edge dump: what `reindexNoteFromBody` sends to the index and
 *  `vault_indices_all_edges` hands back. */
function desktopEdgeDump(): Array<[string, WikilinkEdge[]]> {
  return GRAPH_CONTRACT_NOTES.map((n) => [
    n.noteUuid,
    extractWikilinkEdges(parse(n.body).wikilinks),
  ]);
}

describe("graph model contract (desktop pipeline)", () => {
  it("builds the one expected model from the shared fixture", () => {
    const model = buildGraphModel(desktopEdgeDump(), GRAPH_CONTRACT_RESOLVER_NOTES);
    expect(summarizeGraphModel(model)).toEqual(GRAPH_CONTRACT_EXPECTATION);
  });

  it("keeps orphans as nodes rather than dropping them", () => {
    const model = buildGraphModel(desktopEdgeDump(), GRAPH_CONTRACT_RESOLVER_NOTES);
    expect(model.nodes.map((n) => n.id)).toContain("n-orphan");
    expect(model.edges.some((e) => e.source === "n-orphan" || e.target === "n-orphan")).toBe(false);
  });

  it("never turns a link inside an exclusion zone into an edge", () => {
    const model = buildGraphModel(desktopEdgeDump(), GRAPH_CONTRACT_RESOLVER_NOTES);
    expect(model.edges.some((e) => e.target === "n-ghost")).toBe(false);
  });
});
