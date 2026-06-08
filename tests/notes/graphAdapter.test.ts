// Graph-data adapter (SYNC-9 / MYND-197): whole-vault build (resolve + dedup→
// weight + embed/anchor edges + broken/self-loop drop) and the INDUCED
// neighborhood (inter-neighbor edges present, not just the BFS tree).

import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { foldSegment } from "../../src/dialect/folderPath";
import {
  buildGraphModel,
  inducedNeighborhood,
  isolatedModel,
  loadWholeVaultGraph,
  subgraphModel,
  type GraphModel,
} from "../../src/notes/graphAdapter";
import type { ResolverNote } from "../../src/notes/resolveWikilink";
import type { WikilinkEdge } from "../../src/notes/vaultIndices";

afterEach(() => invokeMock.mockReset());

function note(uuid: string, title: string | null): ResolverNote {
  return { noteUuid: uuid, title, folder: null };
}

function edge(target: string, opts: Partial<WikilinkEdge> = {}): WikilinkEdge {
  return {
    target,
    targetKind: "title",
    titleKey: foldSegment(target),
    anchor: null,
    blockId: null,
    alias: null,
    embed: false,
    byteStart: 0,
    byteEnd: 0,
    ...opts,
  };
}

function model(
  nodeIds: string[],
  edges: ReadonlyArray<readonly [string, string]>,
): GraphModel {
  return {
    nodes: nodeIds.map((id) => ({ id, title: id })),
    edges: edges.map(([source, target]) => ({ source, target, weight: 1 })),
  };
}

describe("buildGraphModel", () => {
  const notes = [note("a", "Alpha"), note("b", "Beta"), note("c", "Gamma")];

  it("nodes are every live note (orphans appear isolated)", () => {
    const g = buildGraphModel([], notes);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(g.edges).toEqual([]);
  });

  it("collapses per-occurrence duplicates into one weighted edge", () => {
    const g = buildGraphModel([["a", [edge("Beta"), edge("Beta")]]], notes);
    expect(g.edges).toEqual([{ source: "a", target: "b", weight: 2 }]);
  });

  it("counts embed and anchor references as edges (no false orphans)", () => {
    const g = buildGraphModel(
      [
        ["a", [edge("Beta", { embed: true })]],
        ["c", [edge("Beta", { anchor: "Heading" })]],
      ],
      notes,
    );
    const pairs = g.edges.map((e) => `${e.source}->${e.target}`).sort();
    expect(pairs).toEqual(["a->b", "c->b"]);
  });

  it("drops broken links (no resolved target → no edge)", () => {
    const g = buildGraphModel([["a", [edge("Nonexistent")]]], notes);
    expect(g.edges).toEqual([]);
  });

  it("drops self-loops", () => {
    const g = buildGraphModel([["a", [edge("Alpha")]]], notes);
    expect(g.edges).toEqual([]);
  });
});

describe("inducedNeighborhood", () => {
  it("includes inter-neighbor (induced) edges, not just the BFS tree", () => {
    // triangle: a→b, a→c, b→c. 1 hop out from a reaches {a,b,c}; the induced
    // subgraph must include b→c even though it is not on a's BFS tree.
    const g = model(["a", "b", "c", "d"], [
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
    const n = inducedNeighborhood(g, "a", 1, "out");
    expect(n.nodes.map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
    const pairs = n.edges.map((e) => `${e.source}->${e.target}`).sort();
    expect(pairs).toEqual(["a->b", "a->c", "b->c"]);
  });

  it("expands by hop depth (1 vs 2)", () => {
    const chain = model(["a", "b", "c", "d"], [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
    ]);
    expect(
      inducedNeighborhood(chain, "a", 1, "out").nodes.map((n) => n.id).sort(),
    ).toEqual(["a", "b"]);
    expect(
      inducedNeighborhood(chain, "a", 2, "out").nodes.map((n) => n.id).sort(),
    ).toEqual(["a", "b", "c"]);
  });

  it("follows direction (in vs out)", () => {
    const chain = model(["a", "b", "c"], [
      ["a", "b"],
      ["b", "c"],
    ]);
    expect(
      inducedNeighborhood(chain, "c", 1, "in").nodes.map((n) => n.id).sort(),
    ).toEqual(["b", "c"]);
    expect(
      inducedNeighborhood(chain, "c", 1, "out").nodes.map((n) => n.id).sort(),
    ).toEqual(["c"]);
  });
});

describe("subgraphModel (tag-filter subset)", () => {
  it("keeps only the subset nodes and the edges among them", () => {
    const g = model(["a", "b", "c"], [
      ["a", "b"],
      ["b", "c"],
      ["a", "c"],
    ]);
    const sub = subgraphModel(g, new Set(["a", "b"]));
    expect(sub.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    // a→c and b→c drop (c excluded); only a→b survives.
    expect(sub.edges.map((e) => `${e.source}->${e.target}`)).toEqual(["a->b"]);
  });
});

describe("isolatedModel (orphans-only)", () => {
  it("renders the orphan notes as isolated nodes with no edges", () => {
    const notes = [note("a", "Alpha"), note("b", "Beta"), note("c", "Gamma")];
    const m = isolatedModel(["a", "c"], notes);
    expect(m.nodes.map((n) => n.id).sort()).toEqual(["a", "c"]);
    expect(m.edges).toEqual([]);
  });
});

describe("loadWholeVaultGraph (route-by-count, SYNC-11)", () => {
  it("returns null and does NOT dump when the vault is over the cap", async () => {
    const notes = [note("a", "A"), note("b", "B"), note("c", "C")];
    const result = await loadWholeVaultGraph(notes, 2);
    expect(result).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled(); // no all_edges dump at scale
  });

  it("dumps + builds at or below the cap", async () => {
    invokeMock.mockResolvedValueOnce([["a", [edge("B")]]]);
    const notes = [note("a", "A"), note("b", "B")];
    const result = await loadWholeVaultGraph(notes, 10);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result?.edges).toEqual([{ source: "a", target: "b", weight: 1 }]);
  });
});
