// Unit tests for the capability-summary derivation (view-manifests task 6).
//
// The derivation is the consent surface's whole claim: it is what makes "which
// properties does this view read" answerable without trusting the view's author.
// So the cases below are the ones where a plausible implementation is silently
// wrong rather than the happy path:
//
//   1. a property the FILTER references and no column names must still be read,
//      because that is the key an under-declaring author would have hidden;
//   2. the cover property, the group key and the sort key are reads too, and none
//      of them appears in the filter;
//   3. the boolean structure survives into the selection projection, since a
//      summary that flattened an OR into a list would describe a narrower view
//      than the one being offered;
//   4. nothing is written when `write_fields` is absent, and `write_fields` keys
//      do not leak into the read set.
//
// The last case is the anchor against a summary that stops being derived: the
// fixture carries a property key nowhere in the definition, and the derived set
// must not contain it.

import { describe, expect, it } from "vitest";
import type { SavedView } from "../../src/lib/prefs";
import { viewCapabilitySummary } from "../../src/notes/views/capabilitySummary";

function view(overrides: Partial<SavedView> = {}): SavedView {
  return {
    id: "0190a000-0000-7000-8000-0000000000aa",
    name: "Reading list",
    view_type: "table",
    filters: { kind: "all" },
    ...overrides,
  };
}

describe("viewCapabilitySummary", () => {
  it("reads a property the filter references that no column names", () => {
    const summary = viewCapabilitySummary(
      view({
        columns: ["status"],
        filters: {
          kind: "and",
          children: [
            { kind: "hasTag", tag: "books" },
            { kind: "property", key: "finished", op: "==", value: "no" },
          ],
        },
      }),
    );

    expect(summary.readsProperties).toEqual(["status", "finished"]);
    // The point of the case: `finished` is invisible in columns, the cover, the
    // group key and the sort key, so a summary built from the display fields
    // alone would have understated the view.
    expect(summary.readsProperties).not.toContain("title");
  });

  it("counts the cover property, the group key and the sort key as reads", () => {
    const summary = viewCapabilitySummary(
      view({
        view_type: "cards",
        columns: ["status"],
        image: "cover",
        group_by: "series",
        sort: { key: "published", direction: "desc" },
        filters: { kind: "all" },
      }),
    );

    expect(summary.readsProperties).toEqual([
      "status",
      "cover",
      "series",
      "published",
    ]);
    expect(summary.readsEnvelopes).toEqual([]);
  });

  it("dedupes a key that appears in both a column and the filter", () => {
    const summary = viewCapabilitySummary(
      view({
        columns: ["status"],
        sort: { key: "status", direction: "asc" },
        filters: { kind: "property", key: "status", op: "==", value: "done" },
      }),
    );

    expect(summary.readsProperties).toEqual(["status"]);
  });

  it("collects the note envelopes the filter references, in traversal order", () => {
    const summary = viewCapabilitySummary(
      view({
        filters: {
          kind: "or",
          children: [
            { kind: "hasTag", tag: "books" },
            { kind: "inFolder", path: "Library/" },
            { kind: "search", query: "unread" },
            { kind: "not", child: { kind: "hasTag", tag: "someday" } },
          ],
        },
      }),
    );

    expect(summary.readsEnvelopes).toEqual([
      { kind: "tag", value: "books" },
      { kind: "folder", value: "Library/" },
      { kind: "search", value: "unread" },
      { kind: "tag", value: "someday" },
    ]);
  });

  it("preserves and/or/not rather than flattening them into one list", () => {
    const summary = viewCapabilitySummary(
      view({
        filters: {
          kind: "or",
          children: [
            { kind: "hasTag", tag: "books" },
            {
              kind: "and",
              children: [
                { kind: "inFolder", path: "Library/" },
                { kind: "property", key: "finished", op: "==", value: "no" },
              ],
            },
          ],
        },
      }),
    );

    expect(summary.selection).toEqual({
      kind: "or",
      children: [
        { kind: "condition", condition: { kind: "tag", value: "books" } },
        {
          kind: "and",
          children: [
            { kind: "condition", condition: { kind: "folder", value: "Library/" } },
            {
              kind: "condition",
              condition: {
                kind: "property",
                key: "finished",
                op: "==",
                value: "no",
              },
            },
          ],
        },
      ],
    });
  });

  it("keeps a negation on the selection it negates", () => {
    const summary = viewCapabilitySummary(
      view({ filters: { kind: "not", child: { kind: "hasTag", tag: "archive" } } }),
    );

    expect(summary.selection).toEqual({
      kind: "not",
      child: { kind: "condition", condition: { kind: "tag", value: "archive" } },
    });
  });

  it("reports an unfiltered view as selecting every note", () => {
    expect(viewCapabilitySummary(view()).selection).toEqual({ kind: "everyNote" });
  });

  it("writes nothing when the definition declares no write authority", () => {
    expect(viewCapabilitySummary(view()).writesProperties).toEqual([]);
  });

  it("keeps declared write fields out of the read set", () => {
    const summary = viewCapabilitySummary(
      view({ columns: ["status"], write_fields: ["status", "priority"] }),
    );

    expect(summary.writesProperties).toEqual(["status", "priority"]);
    // `status` is read because it is a COLUMN, not because it is writable;
    // `priority` is writable and never read, which is the distinction the
    // consent surface draws between "reads" and "can change".
    expect(summary.readsProperties).toEqual(["status"]);
  });

  it("reports no template, because this format does not carry one", () => {
    expect(viewCapabilitySummary(view()).template).toBeNull();
  });

  it("discloses a template if a definition ever carries one", () => {
    const withTemplate = view() as SavedView & { template?: string };
    withTemplate.template = "book";

    expect(viewCapabilitySummary(withTemplate).template).toBe("book");
  });
});
