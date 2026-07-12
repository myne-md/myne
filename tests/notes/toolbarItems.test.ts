import { describe, expect, it } from "vitest";
import {
  EDITOR_TOOLBAR_DEFAULT_HIDDEN,
  EDITOR_TOOLBAR_DEFAULT_ORDER,
  EDITOR_TOOLBAR_ITEMS,
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
      "heading",
      "link",
    ]);
  });

  it("honors a custom order for known ids, then appends the rest", () => {
    const order = resolveToolbarOrder(["link", "bold"], EDITOR_TOOLBAR_DEFAULT_HIDDEN);
    expect(order.slice(0, 2)).toEqual(["link", "bold"]);
    // The remaining shown items follow in canonical order.
    expect(order).toContain("highlight");
    expect(order).not.toContain("quote"); // hidden by default
  });

  it("dropping an id from `hidden` reveals it (add a button)", () => {
    const hidden = EDITOR_TOOLBAR_DEFAULT_HIDDEN.filter((id) => id !== "quote");
    expect(resolveToolbarOrder([], hidden)).toContain("quote");
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
