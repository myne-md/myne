// Tests for the "Save current filter as view" dispatch seam (Saved Views #4,
// MYND-274, task 5). Pure — no IPC.

import { describe, expect, it } from "vitest";
import {
  buildViewFromTags,
  defaultFilterViewName,
} from "../../src/notes/savedViewFromFilter";

describe("buildViewFromTags", () => {
  it("a single selected tag → a bare hasTag leaf", () => {
    const v = buildViewFromTags("v1", ["rust"], "and", "Rust notes");
    expect(v).toEqual({
      id: "v1",
      name: "Rust notes",
      view_type: "cards",
      filters: { kind: "hasTag", tag: "rust" },
    });
  });

  it("multiple tags + AND → an and-node over hasTag leaves", () => {
    const v = buildViewFromTags("v2", ["rust", "async"], "and", "Both");
    expect(v.filters).toEqual({
      kind: "and",
      children: [
        { kind: "hasTag", tag: "rust" },
        { kind: "hasTag", tag: "async" },
      ],
    });
  });

  it("multiple tags + OR → an or-node", () => {
    const v = buildViewFromTags("v3", ["a", "b"], "or", "Either");
    expect(v.filters).toEqual({
      kind: "or",
      children: [
        { kind: "hasTag", tag: "a" },
        { kind: "hasTag", tag: "b" },
      ],
    });
  });

  it("empty selection → an all filter", () => {
    expect(buildViewFromTags("v4", [], "and", "All").filters).toEqual({
      kind: "all",
    });
  });

  it("a blank name falls back to a tag-derived default", () => {
    expect(buildViewFromTags("v5", ["rust", "async"], "and", "   ").name).toBe(
      "rust, async",
    );
    expect(buildViewFromTags("v6", [], "and", "").name).toBe("Filtered view");
  });

  it("defaultFilterViewName joins tags (or 'Filtered view' when empty)", () => {
    expect(defaultFilterViewName(["x", "y"])).toBe("x, y");
    expect(defaultFilterViewName([])).toBe("Filtered view");
  });
});
