import { describe, expect, it } from "vitest";
import {
  EDITOR_TOOLBAR_DEFAULT_HIDDEN,
  EDITOR_TOOLBAR_DEFAULT_ORDER,
  EDITOR_TOOLBAR_ITEMS,
  EDITOR_TOOLBAR_PENDING_IDS,
  resolveToolbarHidden,
  resolveToolbarOrder,
  toolbarItemLabelKey,
} from "../../src/notes/toolbarItems";

// MYND-336 — the toolbar customization vocabulary + resolver (reorder/show-hide
// over a frozen command set, reusing barItemsOrder).
describe("resolveToolbarOrder", () => {
  it("empty stored order + default hidden → today's shown set in canonical order", () => {
    expect(resolveToolbarOrder([], EDITOR_TOOLBAR_DEFAULT_HIDDEN)).toEqual([
      "bold",
      "italic",
      "strike",
      "code",
      "highlight",
      "link",
      "heading",
    ]);
  });

  it("honors a custom order for known ids, then appends the rest", () => {
    const order = resolveToolbarOrder(["link", "bold"], EDITOR_TOOLBAR_DEFAULT_HIDDEN);
    expect(order.slice(0, 2)).toEqual(["link", "bold"]);
    // The remaining shown items follow in canonical order.
    expect(order).toContain("highlight");
    expect(order).not.toContain("quote"); // hidden by default
  });

  it("dropping a RENDERABLE id from `hidden` reveals it (add a button)", () => {
    // Hide `italic`, then drop it from the stored hidden set again — through the
    // normalization helper, as both consumers do. The pending (not-yet-rendered)
    // ids are pinned and can NOT be revealed this way; see the pinning suite.
    const withItalicHidden = resolveToolbarHidden([...EDITOR_TOOLBAR_PENDING_IDS, "italic"]);
    expect(resolveToolbarOrder([], withItalicHidden)).not.toContain("italic");
    const revealed = resolveToolbarHidden([...EDITOR_TOOLBAR_PENDING_IDS]);
    expect(resolveToolbarOrder([], revealed)).toContain("italic");
  });

  it("hiding a default-shown id removes it", () => {
    const order = resolveToolbarOrder([], [...EDITOR_TOOLBAR_DEFAULT_HIDDEN, "italic"]);
    expect(order).not.toContain("italic");
    expect(order).toContain("bold");
  });

  it("ignores unknown / duplicate stored ids", () => {
    const order = resolveToolbarOrder(["bogus", "bold", "bold"], EDITOR_TOOLBAR_DEFAULT_HIDDEN);
    expect(order).not.toContain("bogus");
    expect(order.filter((id) => id === "bold")).toHaveLength(1);
  });
});

// The MYND-336 follow-up gap: five vocabulary ids the floating toolbar cannot
// render yet are PINNED hidden by `resolveToolbarHidden`, so no stored layout
// can demand a button the toolbar would silently drop — and the empty-means-
// unset prefs fallback stays unambiguous (a real stored value always carries
// at least the pinned ids, so `[]` can only mean "never customized").
describe("resolveToolbarHidden (pinned not-yet-renderable ids)", () => {
  it("empty stored value = unset → the default hidden set", () => {
    expect(resolveToolbarHidden([])).toEqual([...EDITOR_TOOLBAR_DEFAULT_HIDDEN]);
  });

  it("unions a stored value with the pending ids (no duplicates)", () => {
    const resolved = resolveToolbarHidden(["italic", "quote"]);
    expect(resolved).toContain("italic");
    for (const id of EDITOR_TOOLBAR_PENDING_IDS) {
      expect(resolved.filter((x) => x === id)).toHaveLength(1);
    }
  });

  it("a stored value that tries to reveal a pending id does NOT lift the pin", () => {
    const stored = EDITOR_TOOLBAR_DEFAULT_HIDDEN.filter((id) => id !== "quote");
    const shown = resolveToolbarOrder([], resolveToolbarHidden(stored));
    expect(shown).not.toContain("quote");
  });

  it("every pending id is in the vocabulary", () => {
    const ids = new Set(EDITOR_TOOLBAR_ITEMS.map((i) => i.id));
    for (const id of EDITOR_TOOLBAR_PENDING_IDS) expect(ids.has(id)).toBe(true);
  });
});

describe("toolbar vocabulary integrity", () => {
  it("default order lists exactly the vocabulary ids", () => {
    expect([...EDITOR_TOOLBAR_DEFAULT_ORDER].sort()).toEqual(
      EDITOR_TOOLBAR_ITEMS.map((i) => i.id).sort(),
    );
  });

  it("every default-hidden id is in the vocabulary", () => {
    const ids = new Set(EDITOR_TOOLBAR_ITEMS.map((i) => i.id));
    for (const id of EDITOR_TOOLBAR_DEFAULT_HIDDEN) expect(ids.has(id)).toBe(true);
  });

  it("labelKey resolves for known ids and null otherwise", () => {
    expect(toolbarItemLabelKey("bold")).toBe("editor.toolbar.customize.bold");
    expect(toolbarItemLabelKey("nope")).toBeNull();
  });
});
