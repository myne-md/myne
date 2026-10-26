// @vitest-environment jsdom
//
// `<ViewConsent>` component tests (view-manifests task 6).
//
// The derivation has its own spec (`tests/notes/capabilitySummary.test.ts`).
// What only a render can prove is the half this surface exists for: that the
// copy is CONCRETE (the keys are on screen) and that it never rounds the read
// set up into a summary sentence. The denial case is the load-bearing one: a
// later "reads everything it needs" line would pass every derivation test and
// undo the mitigation.
//
// Rendered against the real English catalogue (`tests/setup-i18n.ts`), not a
// key-echoing stub, because a stub would turn every copy assertion into a test
// of the key names.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SavedView } from "../../src/lib/prefs";
import { ViewConsent } from "../../src/components/ViewConsent";

afterEach(cleanup);

function view(overrides: Partial<SavedView> = {}): SavedView {
  return {
    id: "0190a000-0000-7000-8000-0000000000aa",
    name: "Reading list",
    view_type: "table",
    filters: { kind: "all" },
    ...overrides,
  };
}

describe("ViewConsent", () => {
  it("lists every property the view reads, including a filter-only key", () => {
    render(
      <ViewConsent
        definition={view({
          view_type: "cards",
          columns: ["status"],
          image: "cover",
          group_by: "series",
          sort: { key: "published", direction: "desc" },
          filters: {
            kind: "and",
            children: [
              { kind: "hasTag", tag: "books" },
              { kind: "property", key: "finished", op: "==", value: "no" },
            ],
          },
        })}
      />,
    );

    const reads = screen.getByTestId("view-consent.reads");
    const keys = [...reads.querySelectorAll("[data-property]")].map((el) =>
      el.getAttribute("data-property"),
    );
    expect(keys).toEqual(["status", "cover", "series", "published", "finished"]);
    // The condition sentence is rendered too, so a reader can see WHY the key is
    // read rather than only that it is.
    expect(reads.textContent).not.toContain("all properties");
    expect(screen.getByTestId("view-consent.selection").textContent).toContain(
      "Notes tagged #books",
    );
  });

  it("never summarises the read set as everything or all of something", () => {
    render(
      <ViewConsent
        definition={view({
          columns: ["status"],
          filters: { kind: "property", key: "owner", op: "contains", value: "ana" },
        })}
      />,
    );

    const text = screen.getByTestId("view-consent.root").textContent ?? "";
    for (const phrase of [
      "all properties",
      "every property",
      "any property",
      "all fields",
      "every field",
      "everything",
      "all of your notes",
    ]) {
      expect(text.toLowerCase()).not.toContain(phrase);
    }
  });

  it("keeps an OR selection expressed as a choice, not a list of requirements", () => {
    render(
      <ViewConsent
        definition={view({
          filters: {
            kind: "or",
            children: [
              { kind: "hasTag", tag: "books" },
              { kind: "inFolder", path: "Library/" },
            ],
          },
        })}
      />,
    );

    const selection = screen.getByTestId("view-consent.selection").textContent ?? "";
    expect(selection).toContain("Any one of these is enough:");
    expect(selection).toContain("Notes tagged #books");
    expect(selection).toContain("Notes in Library/");
    expect(selection).not.toContain("All of these apply:");
  });

  it("omits the read and write sections when there is nothing to state", () => {
    render(<ViewConsent definition={view()} />);

    // An unfiltered, column-less view reads no property and writes nothing. Both
    // sections are omitted rather than rendered as "none": a greyed row reads as
    // a field the reader failed to fill in.
    expect(screen.queryByTestId("view-consent.reads")).toBeNull();
    expect(screen.queryByTestId("view-consent.writes")).toBeNull();
    expect(screen.getByTestId("view-consent.selection").textContent).toContain(
      "Every note in this vault.",
    );
  });

  it("names the writable fields and says the host checks each change", () => {
    render(
      <ViewConsent
        definition={view({
          columns: ["status"],
          write_fields: ["status", "priority"],
        })}
      />,
    );

    const writes = screen.getByTestId("view-consent.writes");
    const keys = [...writes.querySelectorAll("[data-property]")].map((el) =>
      el.getAttribute("data-property"),
    );
    expect(keys).toEqual(["status", "priority"]);
    expect(writes.textContent).toContain("Myne checks every change");
  });

  it("states that a view is data and cannot run code", () => {
    render(<ViewConsent definition={view()} />);

    expect(
      screen.getByTestId("view-consent.data-not-code").textContent,
    ).toContain("It cannot run code.");
  });
});
