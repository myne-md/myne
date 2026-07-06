import { describe, it, expect } from "vitest";
import { evaluateFilter, type QueryCtx } from "../src/lib/query-engine";
import type { FilterNode } from "../src/lib/prefs";

const ctx: QueryCtx = {
  liveIds: new Set(["1", "2", "3", "4"]),
  tagMembers: (t) => (t === "work" ? ["1", "2"] : t === "urgent" ? ["2"] : []),
  folderMembers: (p) => (p === "A/" ? ["2", "3"] : []),
  searchMembers: (q) => (q === "hello" ? ["3", "9"] : []), // 9 is not live
};

describe("evaluateFilter", () => {
  const ids = (n: FilterNode) => [...evaluateFilter(n, ctx)].sort();

  it("all → every live id", () => {
    expect(ids({ kind: "all" })).toEqual(["1", "2", "3", "4"]);
  });

  it("hasTag is gated to the live set", () => {
    expect(ids({ kind: "hasTag", tag: "work" })).toEqual(["1", "2"]);
  });

  it("search drops non-live results", () => {
    expect(ids({ kind: "search", query: "hello" })).toEqual(["3"]);
  });

  it("and = intersection", () => {
    expect(ids({ kind: "and", children: [{ kind: "hasTag", tag: "work" }, { kind: "inFolder", path: "A/" }] })).toEqual(["2"]);
  });

  it("or = union", () => {
    expect(ids({ kind: "or", children: [{ kind: "hasTag", tag: "urgent" }, { kind: "inFolder", path: "A/" }] })).toEqual(["2", "3"]);
  });

  it("not = live complement", () => {
    expect(ids({ kind: "not", child: { kind: "hasTag", tag: "work" } })).toEqual(["3", "4"]);
  });

  it("property leaf is unsupported on mobile (empty set)", () => {
    expect(evaluateFilter({ kind: "property", key: "x", op: "==", value: "y" }, ctx).size).toBe(0);
  });
});
