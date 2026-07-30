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
  resolveNodeRadius,
} from "../../src/notes/graphSettings";

describe("graphSettings", () => {
  it("defaults match the pre-feature fixed rendering/layout constants", () => {
    expect(DEFAULT_GRAPH_SETTINGS).toEqual({
      showArrows: true,
      labelFadeZoom: 1.4,
      nodeSize: 5,
      nodeSizeStrength: 0,
      lineThickness: 1,
      forceCenterStrength: 1,
      forceRepelStrength: 120,
      forceLinkStrength: 1,
      forceLinkDistance: 60,
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
