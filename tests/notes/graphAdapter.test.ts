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
  loadNeighborhood,
  loadSubgraphForNotes,
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

  it("skips a dumped source that is not in the live note-set (trashed)", () => {
    // "z" was dumped (still in the Rust index) but isn't a live note — its
    // outbound edges must contribute nothing (T3 trash exclusion at build).
    const g = buildGraphModel(
      [
        ["z", [edge("Alpha")]], // z not live → skipped entirely
        ["b", [edge("Alpha")]], // b live → b→a edge
      ],
      notes,
    );
    expect(g.edges).toEqual([{ source: "b", target: "a", weight: 1 }]);
  });
});

describe("inducedNeighborhood direction=both", () => {
  it("reaches both predecessors and successors in one hop", () => {
    // p → seed → s : `both` from seed reaches p (in) and s (out).
    const g = model(["p", "seed", "s", "x"], [
      ["p", "seed"],
      ["seed", "s"],
    ]);
    const n = inducedNeighborhood(g, "seed", 1, "both");
    expect(n.nodes.map((x) => x.id).sort()).toEqual(["p", "s", "seed"]);
  });

  it("stops early when the frontier empties before reaching depth", () => {
    const g = model(["a", "b"], [["a", "b"]]);
    // depth 2 requested but b has no further out-edges → no over-reach/crash.
    const n = inducedNeighborhood(g, "a", 2, "out");
    expect(n.nodes.map((x) => x.id).sort()).toEqual(["a", "b"]);
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

describe("loadWholeVaultGraph (whole vault, no cap)", () => {
  it("dumps + builds the whole vault", async () => {
    invokeMock.mockResolvedValueOnce([["a", [edge("B")]]]);
    const notes = [note("a", "A"), note("b", "B")];
    const result = await loadWholeVaultGraph(notes);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.edges).toEqual([{ source: "a", target: "b", weight: 1 }]);
  });

  it("still dumps for a large vault — the node cap is gone", async () => {
    // Previously a > 1500-note vault returned null without dumping; now the
    // whole vault always dumps + builds (scale handled by the worker + culling).
    invokeMock.mockResolvedValueOnce([]);
    const notes = Array.from({ length: 2000 }, (_, i) => note(`n${i}`, `N${i}`));
    const result = await loadWholeVaultGraph(notes);
    expect(invokeMock).toHaveBeenCalledTimes(1); // dumped, not short-circuited
    expect(result.nodes.length).toBe(2000);
  });
});

describe("loadSubgraphForNotes (per-note forward, within-subset only)", () => {
  const notes = [note("a", "Alpha"), note("b", "Beta"), note("c", "Gamma")];

  it("keeps only edges whose target is inside the subset", async () => {
    // forward(a) → Beta (in subset) + Gamma (NOT in subset, dropped).
    // forward(b) → Alpha (in subset).
    invokeMock.mockImplementation((cmd: string, args: { noteId: string }) => {
      if (cmd === "plugin:vault-indices|vault_indices_forward") {
        if (args.noteId === "a") return Promise.resolve([edge("Beta"), edge("Gamma")]);
        if (args.noteId === "b") return Promise.resolve([edge("Alpha")]);
      }
      return Promise.resolve([]);
    });
    const g = await loadSubgraphForNotes(["a", "b"], notes);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    const pairs = g.edges.map((e) => `${e.source}->${e.target}`).sort();
    // a→b kept; a→c dropped (c not in subset); b→a kept.
    expect(pairs).toEqual(["a->b", "b->a"]);
  });

  it("collapses duplicate occurrences into one weighted edge", async () => {
    invokeMock.mockImplementation((cmd: string, args: { noteId: string }) => {
      if (cmd === "plugin:vault-indices|vault_indices_forward" && args.noteId === "a") {
        return Promise.resolve([edge("Beta"), edge("Beta")]);
      }
      return Promise.resolve([]);
    });
    const g = await loadSubgraphForNotes(["a", "b"], notes);
    expect(g.edges).toEqual([{ source: "a", target: "b", weight: 2 }]);
  });
});

describe("loadNeighborhood (BFS via forward+backlinks, induced)", () => {
  const notes = [note("seed", "Seed"), note("out1", "Out1"), note("in1", "In1")];

  it("direction=out follows forward() only", async () => {
    invokeMock.mockImplementation((cmd: string, args: { noteId: string }) => {
      if (cmd === "plugin:vault-indices|vault_indices_forward") {
        return Promise.resolve(args.noteId === "seed" ? [edge("Out1")] : []);
      }
      return Promise.resolve([]);
    });
    const g = await loadNeighborhood("seed", 1, "out", notes);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["out1", "seed"]);
  });

  it("direction=both merges a forward successor and a backlink predecessor", async () => {
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "plugin:vault-indices|vault_indices_forward") {
        return Promise.resolve(args.noteId === "seed" ? [edge("Out1")] : []);
      }
      if (cmd === "plugin:vault-indices|vault_indices_backlink_candidates") {
        // in1 → Seed: a candidate that resolves to seed when queried for seed.
        return args.titleKey === foldSegment("Seed")
          ? Promise.resolve([{ source: "in1", edge: edge("Seed") }])
          : Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
    const g = await loadNeighborhood("seed", 1, "both", notes);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["in1", "out1", "seed"]);
  });
});
