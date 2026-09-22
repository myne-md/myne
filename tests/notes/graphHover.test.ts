// The graph's hover-highlight policy (myne-md/myne#727).
//
// The rule the canvas implements is "the hovered node, its neighbours and the
// edges touching it stay lit, everything else recedes". That is asserted here
// rather than by reading pixels, because the pixel is the last step of the
// rule and the worst place to check it.

import { describe, expect, it } from "vitest";
import {
  buildHoverHighlight,
  edgeIsLit,
  edgeKey,
  highlightAlpha,
  HOVER_DIM_ALPHA,
  nodeIsLit,
} from "@myne/editor/host/notes/graphHover";

const links = [
  { source: "a", target: "b" },
  { source: "a", target: "c" },
  { source: "b", target: "c" }, // among neighbours, but does NOT touch a
  { source: "d", target: "e" }, // a separate component
];

describe("buildHoverHighlight", () => {
  it("returns null when nothing is hovered, which is the no-dim case", () => {
    expect(buildHoverHighlight(null, links)).toBeNull();
  });

  it("keeps the hovered node and its immediate neighbours", () => {
    const h = buildHoverHighlight("a", links);
    expect(h).not.toBeNull();
    expect([...h!.nodes].sort()).toEqual(["a", "b", "c"]);
    // The hovered node itself is carried explicitly: the renderer draws an
    // anchor ring on it, and "the member that is not a neighbour" is not a
    // question the membership sets can answer.
    expect(h!.id).toBe("a");
  });

  it("keeps the edges that touch the hovered node, and not the ones between neighbours", () => {
    // The b-c edge connects two lit nodes but does not touch the hovered node.
    // Dimming it is the deliberate reading: "the connections of this note"
    // means the edges it is an endpoint of, which is what a reader follows.
    const h = buildHoverHighlight("a", links);
    expect(h!.edges.has(edgeKey("a", "b"))).toBe(true);
    expect(h!.edges.has(edgeKey("a", "c"))).toBe(true);
    expect(h!.edges.has(edgeKey("b", "c"))).toBe(false);
    expect(h!.edges.has(edgeKey("d", "e"))).toBe(false);
  });

  it("handles an isolated node: it lights alone and lights no edge", () => {
    const h = buildHoverHighlight("z", links);
    expect([...h!.nodes]).toEqual(["z"]);
    expect(h!.edges.size).toBe(0);
  });

  it("treats an edge as directed, so the two directions are distinct keys", () => {
    expect(edgeKey("a", "b")).not.toBe(edgeKey("b", "a"));
    const h = buildHoverHighlight("b", links);
    expect(h!.edges.has(edgeKey("a", "b"))).toBe(true);
    expect(h!.edges.has(edgeKey("b", "a"))).toBe(false);
  });
});

describe("lit predicates", () => {
  it("everything is lit when nothing is hovered", () => {
    expect(nodeIsLit(null, "anything")).toBe(true);
    expect(edgeIsLit(null, "a", "d")).toBe(true);
    expect(highlightAlpha(null, false)).toBe(1);
  });

  it("separates lit from dimmed once a node is hovered", () => {
    const h = buildHoverHighlight("a", links);
    expect(nodeIsLit(h, "a")).toBe(true);
    expect(nodeIsLit(h, "b")).toBe(true);
    expect(nodeIsLit(h, "d")).toBe(false);
    expect(edgeIsLit(h, "a", "b")).toBe(true);
    expect(edgeIsLit(h, "d", "e")).toBe(false);
    expect(highlightAlpha(h, true)).toBe(1);
    expect(highlightAlpha(h, false)).toBe(HOVER_DIM_ALPHA);
  });
});
