// @vitest-environment jsdom
//
// myne-md/myne#908 item 1 — the band must SAY what the border used to imply.
//
// Solid meant "already in your vault" and dashed meant "accepting this grows
// your vocabulary", and the only place that was written down was a source
// comment. The widget now renders two labelled groups when both kinds are
// present, and the flat row it always rendered when only one kind is.
//
// The two shapes are asserted against the composed editor's real DOM, not a
// helper's return value, because the failure this catches is a decoration that
// stops re-rendering.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Mounted, mount, teardown } from "./_conformance";
import { setTagSuggestions } from "@myne/editor/decorations/tag-suggestion-band";

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
});

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

const band = () => document.querySelector(".cm-tag-suggestion-band");
const groups = () => document.querySelectorAll(".cm-tag-suggestion-group");

function mountWith(chips: readonly { tag: string; isNew: boolean }[]): Mounted {
  const mounted = mount("---\ntitle: note\n---\nbody\n", 5);
  mounted.view.dispatch({ effects: setTagSuggestions.of(chips) });
  return mounted;
}

describe("the tag suggestion band", () => {
  it("groups existing and new tags when both are present", () => {
    m = mountWith([
      { tag: "vault-tag", isNew: false },
      { tag: "fresh-tag", isNew: true },
    ]);
    expect(band()).not.toBeNull();
    expect(groups().length).toBe(2);
    const labels = Array.from(groups()).map((g) =>
      g.querySelector(".cm-tag-suggestion-group-label")?.textContent,
    );
    expect(labels[0]).not.toBe(labels[1]);
    expect(labels.join(" ")).toContain("vault");
  });

  it("keeps the flat row when every chip is new", () => {
    m = mountWith([
      { tag: "a", isNew: true },
      { tag: "b", isNew: true },
    ]);
    expect(groups().length).toBe(0);
    expect(document.querySelectorAll(".cm-tag-suggestion-chip").length).toBe(2);
  });

  it("keeps the flat row when every chip exists", () => {
    m = mountWith([
      { tag: "a", isNew: false },
      { tag: "b", isNew: false },
    ]);
    expect(groups().length).toBe(0);
    expect(document.querySelectorAll(".cm-tag-suggestion-chip").length).toBe(2);
  });

  it("keeps each chip's accept testid inside its group", () => {
    m = mountWith([
      { tag: "vault-tag", isNew: false },
      { tag: "fresh-tag", isNew: true },
    ]);
    const accepts = document.querySelectorAll("[data-testid='editor.tag-suggestion-chip']");
    expect(accepts.length).toBe(2);
    expect(Array.from(accepts).map((a) => a.getAttribute("data-tag-accept"))).toEqual([
      "vault-tag",
      "fresh-tag",
    ]);
  });
});
