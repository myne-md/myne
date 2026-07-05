import { describe, it, expect } from "vitest";
import { extractWikilinks } from "../src/lib/indices-extract";
import { buildGraphFromEdges, clientEdges } from "../src/lib/backend-graph";

describe("extractWikilinks()", () => {
  const targets = (body: string) => extractWikilinks(body).map((e) => e.target);

  it("extracts simple and aliased links (target only)", () => {
    expect(targets("see [[Alpha]] and [[Beta|b]]")).toEqual(["Alpha", "Beta"]);
  });

  it("trims targets and ignores empty ones", () => {
    expect(targets("[[  Gamma  ]] [[]] [[|x]]")).toEqual(["Gamma"]);
  });

  it("does not match a link spanning a newline", () => {
    expect(targets("[[a\nb]]")).toEqual([]);
  });

  it("excludes attachment (att:) embeds — not note links", () => {
    expect(targets(`text ![[att:${"a".repeat(64)}|c.png]] [[Note]]`)).toEqual(["Note"]);
  });

  it("splits #anchor / ^block / |alias and folds the title-key", () => {
    const [e] = extractWikilinks("[[Área#Heading^blk|Alias]]");
    expect(e.target).toBe("Área");
    expect(e.anchor).toBe("Heading");
    expect(e.blockId).toBe("blk");
    expect(e.alias).toBe("Alias");
    expect(e.titleKey).toBe("área"); // NFC + fold
  });
});

describe("buildGraphFromEdges() over clientEdges()", () => {
  const notes = [
    { id: "1", title: "Alpha" },
    { id: "2", title: "Beta" },
    { id: "3", title: "Gamma" },
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
