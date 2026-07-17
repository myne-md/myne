import { describe, it, expect } from "vitest";
import { parseFilters, buildFilters, type ViewDraft } from "../src/lib/view-filter";
import type { FilterNode } from "../src/lib/prefs";

describe("buildFilters", () => {
  it("empty conditions → all", () => {
    expect(buildFilters({ mode: "and", conditions: [] })).toEqual({ kind: "all" });
  });

  it("one condition → the bare leaf (no wrapper)", () => {
    expect(buildFilters({ mode: "and", conditions: [{ type: "tag", value: "work" }] })).toEqual({
      kind: "hasTag",
      tag: "work",
    });
  });

  it("many conditions → an AND/OR node preserving mode", () => {
    const draft: ViewDraft = {
      mode: "or",
      conditions: [
        { type: "tag", value: "work" },
        { type: "folder", value: "Projects/" },
        { type: "search", value: "todo" },
      ],
    };
    expect(buildFilters(draft)).toEqual({
      kind: "or",
      children: [
        { kind: "hasTag", tag: "work" },
        { kind: "inFolder", path: "Projects/" },
        { kind: "search", query: "todo" },
      ],
    });
  });

  it("drops blank conditions", () => {
    const draft: ViewDraft = { mode: "and", conditions: [{ type: "tag", value: "work" }, { type: "search", value: "  " }] };
    expect(buildFilters(draft)).toEqual({ kind: "hasTag", tag: "work" });
  });

  it("one property condition → the bare property leaf", () => {
    expect(
      buildFilters({ mode: "and", conditions: [{ type: "property", key: "status", op: "==", value: "done" }] }),
    ).toEqual({ kind: "property", key: "status", op: "==", value: "done" });
  });

  it("drops a property condition with a blank KEY, keeps a blank VALUE (desktop sanitizeDraft parity)", () => {
    const draft: ViewDraft = {
      mode: "and",
      conditions: [
        { type: "property", key: "  ", op: "==", value: "high" }, // blank key → dropped
        { type: "property", key: "status", op: "!=", value: "" }, // blank value → kept (`!= ""` is legitimate)
      ],
    };
    expect(buildFilters(draft)).toEqual({ kind: "property", key: "status", op: "!=", value: "" });
  });
});

describe("parseFilters", () => {
  it("all → empty draft", () => {
    expect(parseFilters({ kind: "all" })).toEqual({ mode: "and", conditions: [] });
  });

  it("a bare leaf → single-condition AND draft", () => {
    expect(parseFilters({ kind: "inFolder", path: "A/" })).toEqual({
      mode: "and",
      conditions: [{ type: "folder", value: "A/" }],
    });
  });

  it("round-trips a multi-leaf AND", () => {
    const node: FilterNode = {
      kind: "and",
      children: [{ kind: "hasTag", tag: "x" }, { kind: "search", query: "y" }],
    };
    expect(buildFilters(parseFilters(node))).toEqual(node);
  });

  it("drops non-leaf children (lossy for nested/not)", () => {
    const node: FilterNode = {
      kind: "and",
      children: [
        { kind: "hasTag", tag: "x" },
        { kind: "not", child: { kind: "hasTag", tag: "y" } },
        { kind: "or", children: [{ kind: "hasTag", tag: "z" }] },
      ],
    };
    expect(parseFilters(node)).toEqual({ mode: "and", conditions: [{ type: "tag", value: "x" }] });
  });

  it("keeps property leaves (no longer lossy) — round-trip identity", () => {
    const node: FilterNode = {
      kind: "and",
      children: [
        { kind: "hasTag", tag: "x" },
        { kind: "property", key: "rating", op: ">=", value: "4" },
      ],
    };
    expect(parseFilters(node)).toEqual({
      mode: "and",
      conditions: [
        { type: "tag", value: "x" },
        { type: "property", key: "rating", op: ">=", value: "4" },
      ],
    });
    expect(buildFilters(parseFilters(node))).toEqual(node);
  });

  it("round-trips a bare property leaf", () => {
    const node: FilterNode = { kind: "property", key: "status", op: "contains", value: "urg" };
    expect(buildFilters(parseFilters(node))).toEqual(node);
  });
});
