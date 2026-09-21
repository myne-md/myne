// The desktop half of the cross-client graph-model contract (myne-md/myne#199).
// Runs the shared fixture through the desktop extraction pipeline — parse →
// `extractWikilinkEdges` → `buildGraphModel` — and compares the summary against
// the one expected answer. `mobile/tests/wikilinks.test.ts` runs the same
// fixture through its own pipeline; the two agreeing IS the parity guarantee.

import { describe, expect, it } from "vitest";
import { parse } from "@myne/dialect/parse";
import {
  buildGraphModel,
  extractWikilinkEdges,
  tagKeyFromNodeId,
  tagNodeId,
  withTagNodes,
  type WikilinkEdge,
} from "../../src/notes/graphModel";
import { computeGraphLayout } from "../../src/notes/graphLayoutProtocol";
import {
  GRAPH_CONTRACT_EXPECTATION,
  GRAPH_CONTRACT_LAYOUT_FINGERPRINT,
  GRAPH_CONTRACT_NOTES,
  GRAPH_CONTRACT_RESOLVER_NOTES,
  graphLayoutFingerprint,
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

  it("lays the fixture out to the one expected set of coordinates", () => {
    // The coordinate half of the contract (myne-md/myne#200). The same
    // assertion runs against the mobile client's own entry point, and what it
    // proves now is narrower than it was: the layout is device-local
    // (myne-md/myne#727, decisions/ui/0594 and sync/0595), so the only thing
    // keeping the two clients showing the same picture is that they compile
    // this one kernel rather than each carrying one. A fingerprint moving is
    // the cheapest signal that the sharing stopped being real.
    const model = buildGraphModel(desktopEdgeDump(), GRAPH_CONTRACT_RESOLVER_NOTES);
    const { positions } = computeGraphLayout({
      nodes: model.nodes.map((n) => ({ id: n.id })),
      edges: model.edges.map((e) => ({ source: e.source, target: e.target })),
      seed: {},
    });
    expect(graphLayoutFingerprint(positions)).toBe(GRAPH_CONTRACT_LAYOUT_FINGERPRINT);
  });
});

describe("withTagNodes (myne-md/myne#727 task 18)", () => {
  const base = (): ReturnType<typeof buildGraphModel> =>
    buildGraphModel(desktopEdgeDump(), GRAPH_CONTRACT_RESOLVER_NOTES);

  it("leaves the notes-only model untouched when there are no tags", () => {
    // Identity, not equality: the whole-vault path hands the builder the result
    // of `withTagNodes` every render, and a fresh object per render would
    // re-run `GraphCanvas`'s `[model]` effect, i.e. the layout, for nothing.
    const model = base();
    expect(withTagNodes(model, [])).toBe(model);
  });

  it("adds one node per tag and one edge per tagged note", () => {
    const model = withTagNodes(base(), [
      { key: "work", display: "Work", members: new Set(["n-alpha", "n-beta"]) },
    ]);
    expect(model.nodes).toHaveLength(GRAPH_CONTRACT_RESOLVER_NOTES.length + 1);
    const tag = model.nodes.find((n) => n.kind === "tag");
    expect(tag).toEqual({ id: "tag:work", title: "#Work", kind: "tag" });
    expect(
      model.edges
        .filter((e) => e.source === "tag:work")
        .map((e) => `${e.target}x${e.weight}`)
        .sort(),
    ).toEqual(["n-alphax1", "n-betax1"]);
  });

  it("keeps every note node and every note-to-note edge it was given", () => {
    const before = base();
    const after = withTagNodes(before, [
      { key: "work", display: "Work", members: new Set(["n-alpha"]) },
    ]);
    for (const node of before.nodes) expect(after.nodes).toContainEqual(node);
    for (const edge of before.edges) expect(after.edges).toContainEqual(edge);
  });

  it("drops a tag whose members are all outside the model", () => {
    // A hub floating with no notes around it claims a cluster that is not in
    // this view, worse than no hub at all.
    const model = withTagNodes(base(), [
      { key: "ghost", display: "Ghost", members: new Set(["not-a-note"]) },
    ]);
    expect(model.nodes.some((n) => n.kind === "tag")).toBe(false);
  });

  it("sorts members, so the edge list does not depend on Set iteration order", () => {
    const model = withTagNodes(base(), [
      {
        key: "work",
        display: "Work",
        members: new Set(["n-work-report", "n-alpha", "n-beta"]),
      },
    ]);
    expect(
      model.edges.filter((e) => e.source === "tag:work").map((e) => e.target),
    ).toEqual(["n-alpha", "n-beta", "n-work-report"]);
  });

  it("gives a tag node an id no note UUID can collide with", () => {
    expect(tagNodeId("work")).toBe("tag:work");
    expect(tagKeyFromNodeId("tag:work")).toBe("work");
    expect(tagKeyFromNodeId("0f0b1f2e-0000-4000-8000-000000000000")).toBeNull();
  });
});
