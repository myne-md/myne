import { describe, it, expect } from "vitest";
import { extractWikilinks } from "../src/lib/indices-extract";
import { buildGraphFromEdges, clientEdges } from "../src/lib/backend-graph";
import { buildGraphModel } from "@myne/editor/host/notes/graphModel";
import { computeGraphLayout } from "@myne/editor/host/notes/graphLayout";
import type { ResolverNote } from "@myne/editor/host/notes/resolveWikilink";
import {
  GRAPH_CONTRACT_EXPECTATION,
  GRAPH_CONTRACT_LAYOUT_FINGERPRINT,
  GRAPH_CONTRACT_NOTES,
  GRAPH_CONTRACT_RESOLVER_NOTES,
  graphLayoutFingerprint,
  summarizeGraphModel,
} from "@myne/editor/host/notes/graphModelContract";

// The mobile half of the cross-client graph-model contract (myne-md/myne#199).
// The same fixture runs through the desktop pipeline in the main repo's
// `tests/notes/graphModel.test.ts`; the two agreeing IS the parity guarantee.
describe("graph model contract (mobile pipeline)", () => {
  const bodies = new Map(GRAPH_CONTRACT_NOTES.map((n) => [n.noteUuid, n.body]));

  it("builds the one expected model from the shared fixture", () => {
    const model = buildGraphModel(
      clientEdges(GRAPH_CONTRACT_RESOLVER_NOTES, bodies),
      GRAPH_CONTRACT_RESOLVER_NOTES,
    );
    expect(summarizeGraphModel(model)).toEqual(GRAPH_CONTRACT_EXPECTATION);
  });

  it("projects the model onto NoteGraph without losing a node or an edge", () => {
    const g = buildGraphFromEdges(
      GRAPH_CONTRACT_RESOLVER_NOTES,
      clientEdges(GRAPH_CONTRACT_RESOLVER_NOTES, bodies),
    );
    expect(g.nodes.map((n) => n.id).sort()).toEqual(GRAPH_CONTRACT_EXPECTATION.nodes);
    // One `from→to` pair per model edge, weights collapsed away.
    expect(g.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(
      GRAPH_CONTRACT_EXPECTATION.edges.map((e) => e.replace(/x\d+$/, "")),
    );
  });

  it("lays the fixture out to the one expected set of coordinates", () => {
    // The coordinate half of the contract (myne-md/myne#200). The main repo
    // asserts the same fingerprint from the desktop pipeline, and what it
    // proves now is narrower than it was: the layout is device-local
    // (myne-md/myne#727, decisions/ui/0600 and sync/0601), so the only thing
    // keeping the two clients showing the same picture is that they compile
    // this one kernel rather than each carrying one.
    const model = buildGraphModel(
      clientEdges(GRAPH_CONTRACT_RESOLVER_NOTES, bodies),
      GRAPH_CONTRACT_RESOLVER_NOTES,
    );
    const { positions } = computeGraphLayout({
      nodes: model.nodes.map((n) => ({ id: n.id })),
      edges: model.edges.map((e) => ({ source: e.source, target: e.target })),
      seed: {},
    });
    expect(graphLayoutFingerprint(positions)).toBe(GRAPH_CONTRACT_LAYOUT_FINGERPRINT);
  });

  it("keeps unlinked notes as degree-0 nodes rather than dropping them", () => {
    const g = buildGraphFromEdges(
      GRAPH_CONTRACT_RESOLVER_NOTES,
      clientEdges(GRAPH_CONTRACT_RESOLVER_NOTES, bodies),
    );
    expect(g.nodes.find((n) => n.id === "n-orphan")?.degree).toBe(0);
  });
});

describe("extractWikilinks()", () => {
  const targets = (body: string) => extractWikilinks(body).map((e) => e.target);

  it("extracts simple and aliased links (target only)", () => {
    expect(targets("see [[Alpha]] and [[Beta|b]]")).toEqual(["Alpha", "Beta"]);
  });

  it("splits #anchor and |alias, and folds the title-key", () => {
    const [e] = extractWikilinks("[[Área#Heading|Alias]]");
    expect(e.target).toBe("Área");
    expect(e.anchor).toBe("Heading");
    expect(e.alias).toBe("Alias");
    expect(e.titleKey).toBe("área"); // NFC + fold
  });

  it("splits ^blockId", () => {
    // The retired mobile regex also accepted a COMBINED `#heading^block`
    // target and split it into both fields. `wikilink.md` §2.1 defines the two
    // forms separately and the shared grammar reads `#Heading^blk` as one
    // heading — the regex was inventing a form the spec does not have.
    const [e] = extractWikilinks("[[Área^blk]]");
    expect(e.blockId).toBe("blk");
    expect(e.anchor).toBe(null);
  });

  it("folds the TITLE component of a path-form target, not the whole target", () => {
    // The regex extractor folded `work/report`, which matched no note title —
    // which is why `[[Work/Report]]` produced no edge on this client.
    const [e] = extractWikilinks("[[Work/Report]]");
    expect(e.titleKey).toBe("report");
    expect(e.targetKind).toBe("vault-path");
  });

  it("strips exactly one trailing .md when deriving the title-key", () => {
    expect(extractWikilinks("[[Report.md]]")[0].titleKey).toBe("report");
  });

  it("ignores links inside frontmatter and fenced code blocks", () => {
    const body = ["---", 'a: "[[Ghost]]"', "---", "", "```", "[[Ghost]]", "```", "", "[[Real]]"].join("\n");
    expect(targets(body)).toEqual(["Real"]);
  });

  it("excludes media embeds but keeps note embeds", () => {
    expect(targets("![[diagram.png]] and ![[Note]]")).toEqual(["Note"]);
  });
});

describe("buildGraphFromEdges() over clientEdges()", () => {
  const notes: ResolverNote[] = [
    { noteUuid: "1", title: "Alpha", folder: null },
    { noteUuid: "2", title: "Beta", folder: null },
    { noteUuid: "3", title: "Gamma", folder: null },
  ];
  const graph = (bodies: Map<string, string>) => buildGraphFromEdges(notes, clientEdges(notes, bodies));

  it("resolves links into directed edges + backlinks + degree", () => {
    const g = graph(
      new Map([
        ["1", "links to [[Beta]] and [[Gamma]]"],
        ["2", "back to [[Alpha]]"],
        ["3", "no links here"],
      ]),
    );
    expect(g.edges).toContainEqual({ from: "1", to: "2" });
    expect(g.edges).toContainEqual({ from: "1", to: "3" });
    expect(g.edges).toContainEqual({ from: "2", to: "1" });
    expect(g.backlinks.get("1")).toEqual(["2"]);
    expect(g.forward.get("1")).toEqual(["2", "3"]);
    expect(g.nodes.find((n) => n.id === "1")?.degree).toBe(3);
  });

  it("resolves titles case-insensitively (foldSegment)", () => {
    expect(graph(new Map([["1", "[[beta]]"]])).edges).toEqual([{ from: "1", to: "2" }]);
  });

  it("drops self-links, unresolved targets, and duplicate directed edges", () => {
    expect(graph(new Map([["1", "[[Alpha]] [[Beta]] [[Beta]] [[Missing]]"]])).edges).toEqual([{ from: "1", to: "2" }]);
  });
});
