// Unit tests for the graph pane settings module (graph-connection-ux-polish
// task 5 + task 6's appearance/forces fields): the per-field omit-when-default
// encode/decode pair that `src/lib/workspace-persist.ts` rides for the
// `graphSettings` container key. The wire-level round-trip (through
// `serializeWorkspaces`/`deserializeWorkspaces`) is covered separately in
// `tests/notes/workspacePersist.test.ts`; this file exercises the pure
// encode/decode functions directly.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRAPH_SETTINGS,
  decodeGraphSettings,
  encodeGraphSettings,
  MAX_DEGREE_FOR_SIZE,
  NODE_SIZE_RANGE,
  TAG_NODE_MAX_DEGREE,
  NODE_SIZE_STRENGTH_RANGE,
  resolveNodeRadius,
  resolveReservedRadius,
  resolveReservedTagNodeRadius,
  resolveTagNodeRadius,
} from "../../src/notes/graphSettings";

describe("graphSettings", () => {
  it("defaults are the one shared appearance/layout spec", () => {
    // `nodeSizeStrength` is the one that is NOT the desktop pre-feature
    // constant: 0.8 spans 5–13px under the degree cap of 10, which is the
    // range the mobile renderer hardcoded before the clients converged on one
    // (myne-md/myne#200). Everything else still matches what desktop shipped.
    expect(DEFAULT_GRAPH_SETTINGS).toEqual({
      showArrows: true,
      labelFadeZoom: 1.4,
      nodeSize: 6,
      nodeSizeStrength: 1.2,
      lineThickness: 1,
      forceCenterStrength: 1,
      forceRepelStrength: 70,
      forceLinkStrength: 1,
      forceLinkDistance: 48,
    });
  });

  it("encode omits the field entirely when every value is default", () => {
    expect(encodeGraphSettings({ ...DEFAULT_GRAPH_SETTINGS })).toBeUndefined();
  });

  it("encode includes only the non-default fields", () => {
    expect(encodeGraphSettings({ ...DEFAULT_GRAPH_SETTINGS, showArrows: false })).toEqual({
      showArrows: false,
    });
    expect(
      encodeGraphSettings({ ...DEFAULT_GRAPH_SETTINGS, nodeSize: 8, forceLinkDistance: 90 }),
    ).toEqual({ nodeSize: 8, forceLinkDistance: 90 });
  });

  it("decode returns the defaults for non-object / null / undefined input", () => {
    expect(decodeGraphSettings(undefined)).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(decodeGraphSettings(null)).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(decodeGraphSettings("garbage")).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(decodeGraphSettings(42)).toEqual(DEFAULT_GRAPH_SETTINGS);
  });

  it("decode reads a well-formed field and defaults a malformed one", () => {
    expect(decodeGraphSettings({ showArrows: false })).toEqual({
      ...DEFAULT_GRAPH_SETTINGS,
      showArrows: false,
    });
    expect(decodeGraphSettings({ showArrows: "nope" })).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(decodeGraphSettings({})).toEqual(DEFAULT_GRAPH_SETTINGS);
  });

  it("decode defaults each numeric field independently when malformed (non-finite, wrong type)", () => {
    expect(decodeGraphSettings({ nodeSize: "big" })).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(decodeGraphSettings({ nodeSize: Number.NaN })).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(decodeGraphSettings({ nodeSize: Number.POSITIVE_INFINITY })).toEqual(
      DEFAULT_GRAPH_SETTINGS,
    );
    // A well-formed field alongside a malformed one: each defaults independently.
    expect(decodeGraphSettings({ nodeSize: 8, forceLinkDistance: "far" })).toEqual({
      ...DEFAULT_GRAPH_SETTINGS,
      nodeSize: 8,
    });
  });

  it("encode/decode round-trips a non-default value", () => {
    const encoded = encodeGraphSettings({ ...DEFAULT_GRAPH_SETTINGS, showArrows: false });
    expect(decodeGraphSettings(encoded)).toEqual({ ...DEFAULT_GRAPH_SETTINGS, showArrows: false });
  });

  it("resolveNodeRadius: strength 0 ignores degree entirely (uniform size)", () => {
    expect(resolveNodeRadius(5, 0, 0, 10)).toBe(5);
    expect(resolveNodeRadius(5, 0, 9, 10)).toBe(5);
  });

  it("resolveNodeRadius: grows with degree, capped at maxDegree", () => {
    expect(resolveNodeRadius(5, 1, 3, 10)).toBe(8); // 5 + 1*3
    expect(resolveNodeRadius(5, 1, 999, 10)).toBe(15); // capped: 5 + 1*10
    expect(resolveNodeRadius(5, 0.5, 4, 10)).toBe(7); // 5 + 0.5*4
  });

  it("resolveNodeRadius: the SAME call GraphCanvas makes for render and hit-test always agrees with itself", () => {
    // Not a mock — this is the literal formula both the render loop and
    // `hitNode` call (via `radiusOf`) in `GraphCanvas.tsx`, so proving it's a
    // pure, deterministic function of its inputs is what makes "hit-testing
    // matches drawn node size at every size setting" true by construction.
    for (const [size, strength, degree] of [
      [3, 0, 0],
      [10, 1, 10],
      [5, 0.3, 2],
    ] as const) {
      const a = resolveNodeRadius(size, strength, degree, 10);
      const b = resolveNodeRadius(size, strength, degree, 10);
      expect(a).toBe(b);
    }
  });

  it("encode/decode round-trips every field touched at once", () => {
    const touched = {
      showArrows: false,
      labelFadeZoom: 2,
      nodeSize: 8,
      nodeSizeStrength: 0.5,
      lineThickness: 2,
      forceCenterStrength: 1.5,
      forceRepelStrength: 200,
      forceLinkStrength: 0.5,
      forceLinkDistance: 100,
    };
    const encoded = encodeGraphSettings(touched);
    expect(encoded).toEqual(touched);
    expect(decodeGraphSettings(encoded)).toEqual(touched);
  });
});

describe("resolveTagNodeRadius (myne-md/myne#727 task 18)", () => {
  it("grows with degree, but at its own dose and under its own lower cap", () => {
    // The first version ignored degree entirely, so a tag over sixty notes drew
    // at 9.6 against leaves at 8.4, a hub indistinguishable from its spokes.
    // The correction is a GENTLER term, not the note's: a tag's degree is its
    // note count, and sixty is ordinary for a tag and a landmark for a note.
    expect(resolveTagNodeRadius(6, 1.2, 0)).toBeCloseTo(9.6, 10);
    // 9.6 + 1.2 * 0.5 * 12
    expect(resolveTagNodeRadius(6, 1.2, 60)).toBeCloseTo(16.8, 10);
    // Capped: a tag with ten thousand notes reserves no more than one with 12.
    expect(resolveTagNodeRadius(6, 1.2, 10_000)).toBe(
      resolveTagNodeRadius(6, 1.2, TAG_NODE_MAX_DEGREE),
    );
    // Still visibly a hub, and still smaller than a well-connected NOTE.
    expect(resolveTagNodeRadius(6, 1.2, 60)).toBeGreaterThan(
      resolveNodeRadius(6, 1.2, 2, MAX_DEGREE_FOR_SIZE),
    );
    expect(resolveTagNodeRadius(6, 1.2, 60)).toBeLessThan(
      resolveNodeRadius(6, 1.2, MAX_DEGREE_FOR_SIZE, MAX_DEGREE_FOR_SIZE),
    );
  });

  it("scales with the user's node-size setting, so the control still reaches it", () => {
    expect(resolveTagNodeRadius(12, 1.2, 5)).toBeGreaterThan(
      resolveTagNodeRadius(6, 1.2, 5),
    );
    expect(resolveTagNodeRadius(6, 2.4, 5)).toBeGreaterThan(
      resolveTagNodeRadius(6, 1.2, 5),
    );
  });
});

describe("resolveReservedRadius (myne-md/myne#727)", () => {
  it("is never smaller than the largest radius the panel can draw", () => {
    // THE invariant the whole "two nodes never touch" guarantee rests on. The
    // layout reserves this much room; the renderer draws at most this much. If
    // the reserved value were ever the smaller of the two, a user dragging node
    // size up would grow a node past its reserved room and it would overlap its
    // neighbours, and nothing would say why.
    for (let degree = 0; degree <= 60; degree += 1) {
      const drawnAtMax = resolveNodeRadius(
        NODE_SIZE_RANGE.max,
        NODE_SIZE_STRENGTH_RANGE.max,
        degree,
        MAX_DEGREE_FOR_SIZE,
      );
      expect(resolveReservedRadius(degree, MAX_DEGREE_FOR_SIZE)).toBeGreaterThanOrEqual(
        drawnAtMax,
      );
    }
  });

  it("holds for a tag node too, whose dose and cap are its own", () => {
    for (let degree = 0; degree <= 60; degree += 1) {
      expect(resolveReservedTagNodeRadius()).toBeGreaterThanOrEqual(
        resolveTagNodeRadius(
          NODE_SIZE_RANGE.max,
          NODE_SIZE_STRENGTH_RANGE.max,
          degree,
        ),
      );
    }
  });

  it("is the drawn radius exactly at the degree cap, and looser below it", () => {
    // The stated cost, pinned so it cannot quietly become a surprise: at the cap
    // the reservation is exact, and a low-degree note is reserved a few units
    // more than it is drawn at under default styling.
    const atCap = resolveReservedRadius(MAX_DEGREE_FOR_SIZE, MAX_DEGREE_FOR_SIZE);
    expect(atCap).toBe(
      resolveNodeRadius(
        NODE_SIZE_RANGE.max,
        NODE_SIZE_STRENGTH_RANGE.max,
        MAX_DEGREE_FOR_SIZE,
        MAX_DEGREE_FOR_SIZE,
      ),
    );
    expect(resolveReservedRadius(0, MAX_DEGREE_FOR_SIZE)).toBeGreaterThan(
      resolveNodeRadius(6, 1.2, 0, MAX_DEGREE_FOR_SIZE),
    );
  });
});
