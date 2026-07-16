// Graph layout store: warm-start map + the serialize/hydrate roundtrip that
// backs the encrypted vault.graph persistence (Tier 3).

import { afterEach, describe, expect, it } from "vitest";
import {
  __resetGraphLayoutForTest,
  getGraphPosition,
  hasGraphLayout,
  hydrateGraphLayout,
  seedPositions,
  serializeGraphLayout,
  setGraphPositions,
} from "../../src/notes/graphLayoutStore";

afterEach(() => __resetGraphLayoutForTest());

describe("graphLayoutStore", () => {
  it("stores and reads back positions", () => {
    setGraphPositions([
      { id: "a", x: 1, y: 2 },
      { id: "b", x: 3, y: 4 },
    ]);
    expect(getGraphPosition("a")).toEqual({ x: 1, y: 2 });
    expect(getGraphPosition("missing")).toBeUndefined();
    expect(hasGraphLayout()).toBe(true);
  });

  it("seedPositions returns only known ids", () => {
    setGraphPositions([{ id: "a", x: 1, y: 2 }]);
    expect(seedPositions(["a", "b"])).toEqual({ a: { x: 1, y: 2 } });
  });

  it("serialize → hydrate round-trips the positions", () => {
    setGraphPositions([
      { id: "n1", x: 12.5, y: -8 },
      { id: "n2", x: 100, y: 42 },
    ]);
    const payload = serializeGraphLayout();
    __resetGraphLayoutForTest();
    expect(hasGraphLayout()).toBe(false);
    hydrateGraphLayout(payload);
    expect(getGraphPosition("n1")).toEqual({ x: 12.5, y: -8 });
    expect(getGraphPosition("n2")).toEqual({ x: 100, y: 42 });
  });

  it("hydrate CLEARS first (cross-vault safety)", () => {
    setGraphPositions([{ id: "vaultA-note", x: 1, y: 1 }]);
    // Hydrating vault B's payload must drop vault A's positions entirely.
    hydrateGraphLayout(JSON.stringify({ v: 1, pos: [["vaultB-note", 5, 5]] }));
    expect(getGraphPosition("vaultA-note")).toBeUndefined();
    expect(getGraphPosition("vaultB-note")).toEqual({ x: 5, y: 5 });
  });

  it("hydrate(null) clears the store", () => {
    setGraphPositions([{ id: "a", x: 1, y: 1 }]);
    hydrateGraphLayout(null);
    expect(hasGraphLayout()).toBe(false);
  });

  it("hydrate tolerates malformed payloads (→ empty, recompute)", () => {
    setGraphPositions([{ id: "a", x: 1, y: 1 }]);
    hydrateGraphLayout("not json");
    expect(hasGraphLayout()).toBe(false);
    hydrateGraphLayout(JSON.stringify({ v: 2, pos: [["a", 1, 1]] })); // wrong version
    expect(hasGraphLayout()).toBe(false);
  });

  it("hydrate drops non-finite / malformed entries", () => {
    hydrateGraphLayout(
      JSON.stringify({
        v: 1,
        pos: [
          ["ok", 1, 2],
          ["bad-nan", "x", 2],
          ["bad-short", 3],
        ],
      }),
    );
    expect(getGraphPosition("ok")).toEqual({ x: 1, y: 2 });
    expect(getGraphPosition("bad-nan")).toBeUndefined();
    expect(getGraphPosition("bad-short")).toBeUndefined();
  });
});
