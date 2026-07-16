// The filter builder's pure core (Saved Views #4 / MYND-282, task 1). Round-trip
// between the canonical FilterNode AST and the builder's single-level-group draft
// model, plus the representability classifier that prevents silent condition loss.

import { describe, expect, it } from "vitest";

import type { FilterNode } from "../../src/lib/prefs";
import {
  draftToFilterNode,
  filterNodeToDraft,
  isRepresentable,
  sanitizeDraft,
  type FilterDraft,
} from "../../src/notes/filterDraft";

const EMPTY_DRAFT: FilterDraft = { combinator: "and", groups: [] };

describe("draftToFilterNode", () => {
  it("serializes an empty draft to { kind: 'all' }", () => {
    expect(draftToFilterNode(EMPTY_DRAFT)).toEqual({ kind: "all" });
  });

  it("drops empty groups (no conditions) when serializing", () => {
    const draft: FilterDraft = {
      combinator: "and",
      groups: [
        { combinator: "and", conditions: [] },
        { combinator: "and", conditions: [{ type: "tag", value: "work", negated: false }] },
      ],
    };
    // The empty group is dropped → a single surviving group with one condition
    // collapses to the bare leaf.
    expect(draftToFilterNode(draft)).toEqual({ kind: "hasTag", tag: "work" });
  });

  it("serializes a single condition to a bare leaf", () => {
    const draft: FilterDraft = {
      combinator: "and",
      groups: [{ combinator: "and", conditions: [{ type: "folder", value: "Projects", negated: false }] }],
    };
    expect(draftToFilterNode(draft)).toEqual({ kind: "inFolder", path: "Projects" });
  });

  it("wraps a negated condition in a not node", () => {
    const draft: FilterDraft = {
      combinator: "and",
      groups: [{ combinator: "and", conditions: [{ type: "tag", value: "archived", negated: true }] }],
    };
    expect(draftToFilterNode(draft)).toEqual({
      kind: "not",
      child: { kind: "hasTag", tag: "archived" },
    });
  });

  it("serializes a two-group draft to a 2-level and/or AST", () => {
    const draft: FilterDraft = {
      combinator: "and",
      groups: [
        { combinator: "and", conditions: [{ type: "folder", value: "Projects", negated: false }] },
        {
          combinator: "or",
          conditions: [
            { type: "tag", value: "urgent", negated: false },
            { type: "tag", value: "today", negated: false },
          ],
        },
      ],
    };
    expect(draftToFilterNode(draft)).toEqual({
      kind: "and",
      children: [
        { kind: "inFolder", path: "Projects" },
        {
          kind: "or",
          children: [
            { kind: "hasTag", tag: "urgent" },
            { kind: "hasTag", tag: "today" },
          ],
        },
      ],
    });
  });
});

describe("filterNodeToDraft (parse) + node→draft→node identity", () => {
  const roundTrips = (node: FilterNode) => {
    const draft = filterNodeToDraft(node);
    expect(draft).not.toBeNull();
    expect(draftToFilterNode(draft as FilterDraft)).toEqual(node);
  };

  it("parses { kind: 'all' } to an empty draft", () => {
    expect(filterNodeToDraft({ kind: "all" })).toEqual(EMPTY_DRAFT);
  });

  it("round-trips a single leaf", () => {
    roundTrips({ kind: "hasTag", tag: "work" });
    roundTrips({ kind: "inFolder", path: "Projects" });
    roundTrips({ kind: "search", query: "design system" });
  });

  it("round-trips a negated leaf", () => {
    roundTrips({ kind: "not", child: { kind: "hasTag", tag: "archived" } });
  });

  it("round-trips a flat and/or of leaves (the Tags 'Save as view' shape)", () => {
    roundTrips({
      kind: "or",
      children: [
        { kind: "hasTag", tag: "a" },
        { kind: "hasTag", tag: "b" },
      ],
    });
  });

  it("round-trips a 2-level group AST", () => {
    roundTrips({
      kind: "and",
      children: [
        {
          kind: "or",
          children: [
            { kind: "hasTag", tag: "urgent" },
            { kind: "hasTag", tag: "today" },
          ],
        },
        { kind: "inFolder", path: "Projects" },
      ],
    });
  });

  it("round-trips a bare property leaf under every engine operator", () => {
    const ops = ["==", "!=", ">", "<", ">=", "<=", "contains"] as const;
    for (const op of ops) {
      roundTrips({ kind: "property", key: "status", op, value: "done" });
    }
  });

  it("round-trips a flat AND mixing tag and property leaves (Tags shape + property)", () => {
    roundTrips({
      kind: "and",
      children: [
        { kind: "hasTag", tag: "work" },
        { kind: "property", key: "status", op: "==", value: "done" },
      ],
    });
  });

  it("round-trips a 2-level AST with a property leaf inside a group", () => {
    roundTrips({
      kind: "or",
      children: [
        {
          kind: "and",
          children: [
            { kind: "property", key: "rating", op: ">=", value: "4" },
            { kind: "hasTag", tag: "book" },
          ],
        },
        { kind: "inFolder", path: "Reading" },
      ],
    });
  });
});

describe("isRepresentable / fail-safe guard", () => {
  it("classifies a property leaf as representable (builder row: key + op + value)", () => {
    const node: FilterNode = { kind: "property", key: "priority", op: "==", value: "high" };
    expect(isRepresentable(node)).toBe(true);
    expect(filterNodeToDraft(node)).toEqual({
      combinator: "and",
      groups: [
        {
          combinator: "and",
          conditions: [{ type: "property", key: "priority", op: "==", value: "high" }],
        },
      ],
    });
  });

  it("classifies not(property) as unrepresentable (the property row has no negation — `!=` covers it)", () => {
    const node: FilterNode = {
      kind: "not",
      child: { kind: "property", key: "priority", op: "==", value: "high" },
    };
    expect(isRepresentable(node)).toBe(false);
    expect(filterNodeToDraft(node)).toBeNull();
  });

  it("classifies 3-level nesting as unrepresentable (never silently simplified)", () => {
    const node: FilterNode = {
      kind: "and",
      children: [
        {
          kind: "and",
          children: [
            { kind: "or", children: [{ kind: "hasTag", tag: "a" }, { kind: "hasTag", tag: "b" }] },
            { kind: "search", query: "q" },
          ],
        },
        { kind: "hasTag", tag: "c" },
      ],
    };
    expect(isRepresentable(node)).toBe(false);
    expect(filterNodeToDraft(node)).toBeNull();
  });

  it("classifies a negated group as unrepresentable (only leaf negation is supported)", () => {
    const node: FilterNode = {
      kind: "not",
      child: { kind: "or", children: [{ kind: "hasTag", tag: "a" }, { kind: "hasTag", tag: "b" }] },
    };
    expect(isRepresentable(node)).toBe(false);
  });

  it("classifies not(property) nested inside a group as unrepresentable", () => {
    const node: FilterNode = {
      kind: "and",
      children: [
        { kind: "hasTag", tag: "a" },
        { kind: "not", child: { kind: "property", key: "k", op: "contains", value: "v" } },
      ],
    };
    expect(isRepresentable(node)).toBe(false);
  });

  it("classifies the representable shapes as representable", () => {
    expect(isRepresentable({ kind: "all" })).toBe(true);
    expect(isRepresentable({ kind: "hasTag", tag: "a" })).toBe(true);
    expect(isRepresentable({ kind: "not", child: { kind: "inFolder", path: "p" } })).toBe(true);
    expect(
      isRepresentable({ kind: "or", children: [{ kind: "search", query: "q" }, { kind: "hasTag", tag: "a" }] }),
    ).toBe(true);
    expect(
      isRepresentable({
        kind: "and",
        children: [
          { kind: "hasTag", tag: "a" },
          { kind: "property", key: "k", op: "contains", value: "v" },
        ],
      }),
    ).toBe(true);
  });
});

describe("sanitizeDraft (the live-count + save input)", () => {
  it("drops blank-value conditions and the empty groups they leave", () => {
    const draft: FilterDraft = {
      combinator: "and",
      groups: [
        {
          combinator: "or",
          conditions: [
            { type: "tag", value: "work", negated: false },
            { type: "folder", value: "  ", negated: false }, // blank → dropped
          ],
        },
        {
          combinator: "and",
          conditions: [{ type: "search", value: "", negated: false }], // group empties → dropped
        },
      ],
    };
    expect(sanitizeDraft(draft)).toEqual({
      combinator: "and",
      groups: [{ combinator: "or", conditions: [{ type: "tag", value: "work", negated: false }] }],
    });
  });

  it("an all-blank draft sanitizes to an empty draft (→ all-pages)", () => {
    const draft: FilterDraft = {
      combinator: "and",
      groups: [{ combinator: "and", conditions: [{ type: "tag", value: "", negated: false }] }],
    };
    const sanitized = sanitizeDraft(draft);
    expect(sanitized.groups).toEqual([]);
    expect(draftToFilterNode(sanitized)).toEqual({ kind: "all" });
  });

  it("drops a property condition with a blank key", () => {
    const draft: FilterDraft = {
      combinator: "and",
      groups: [
        {
          combinator: "and",
          conditions: [{ type: "property", key: "  ", op: "==", value: "high" }],
        },
      ],
    };
    expect(sanitizeDraft(draft).groups).toEqual([]);
  });

  it("keeps a property condition with a blank VALUE (`== \"\"` / `!= \"\"` are legitimate queries)", () => {
    const draft: FilterDraft = {
      combinator: "and",
      groups: [
        {
          combinator: "and",
          conditions: [{ type: "property", key: "status", op: "!=", value: "" }],
        },
      ],
    };
    expect(sanitizeDraft(draft)).toEqual(draft);
    expect(draftToFilterNode(sanitizeDraft(draft))).toEqual({
      kind: "property",
      key: "status",
      op: "!=",
      value: "",
    });
  });
});
