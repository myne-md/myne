// Mobile now runs the SHARED query engine (via the `../src/lib/query-engine`
// shim → `@myne/editor/host/notes/queryEngine`). This suite is a mobile-side
// smoke test that the shim resolves and the shared async evaluator behaves as
// expected — including the `property` leaf, which the retired mobile fork
// stubbed to the empty set (it now resolves against the MYI1 property index,
// reaching desktop parity).

import { describe, it, expect } from "vitest";
import {
  evaluateFilter,
  runView,
  type FilterNode,
  type LeafResolvers,
  type RunViewContext,
  type StoredProperty,
} from "../src/lib/query-engine";

const LIVE = new Set(["1", "2", "3", "4"]);

const prop = (key: string, value: string): StoredProperty => ({
  key,
  type: "string",
  value,
});

const resolvers: LeafResolvers = {
  hasTag: async (t) => (t === "work" ? ["1", "2"] : t === "urgent" ? ["2"] : []),
  inFolder: async (p) => (p === "A/" ? ["2", "3"] : []),
  search: async (q) => (q === "hello" ? ["3", "9"] : []), // 9 is not live
  propertyValues: async (key) =>
    key === "status"
      ? [
          ["1", prop("status", "done")],
          ["2", prop("status", "todo")],
        ]
      : [],
};

describe("shared query engine (via the mobile shim)", () => {
  const ids = async (n: FilterNode) =>
    (await evaluateFilter(n, LIVE, resolvers)).sort();

  it("all → every live id", async () => {
    expect(await ids({ kind: "all" })).toEqual(["1", "2", "3", "4"]);
  });

  it("hasTag is gated to the live set", async () => {
    expect(await ids({ kind: "hasTag", tag: "work" })).toEqual(["1", "2"]);
  });

  it("search drops non-live results", async () => {
    expect(await ids({ kind: "search", query: "hello" })).toEqual(["3"]);
  });

  it("and = intersection", async () => {
    expect(
      await ids({
        kind: "and",
        children: [
          { kind: "hasTag", tag: "work" },
          { kind: "inFolder", path: "A/" },
        ],
      }),
    ).toEqual(["2"]);
  });

  it("property leaf now resolves on mobile (was stubbed in the fork)", async () => {
    expect(
      await ids({ kind: "property", key: "status", op: "==", value: "done" }),
    ).toEqual(["1"]);
  });

  it("runView groups by a property (mobile parity)", async () => {
    const ctx: RunViewContext = {
      liveIds: LIVE,
      resolvers,
      rowFor: (id) => ({ title: `Note ${id}`, folder: null }),
      recencyFallback: (xs) => [...xs],
    };
    const result = await runView({ filter: { kind: "all" }, groupBy: "status" }, ctx);
    const keys = result.groups.map((g) => g.key).sort();
    expect(keys).toContain("done");
    expect(keys).toContain("todo");
    expect(keys).toContain(""); // notes 3/4 have no status → the no-value group
  });
});
