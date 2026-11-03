import { describe, expect, it } from "vitest";
import {
  EDITOR_TOOLBAR_DEFAULT_HIDDEN,
  EDITOR_TOOLBAR_DEFAULT_ORDER,
  EDITOR_TOOLBAR_ITEMS,
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

  it("dropping an id from `hidden` reveals it (add a button)", () => {
    // Hide `italic`, then drop it from the stored hidden set again — through the
    // normalization helper, as both consumers do.
    const withItalicHidden = resolveToolbarHidden(["italic", "quote"]);
    expect(resolveToolbarOrder([], withItalicHidden)).not.toContain("italic");
    const revealed = resolveToolbarHidden(["quote"]);
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

// The pin is GONE (issue #970, item 1): all five list/quote/wikilink commands
// render now, so a stored layout that reveals one is honoured rather than
// overridden. What replaced the pin's second job (keeping the empty-means-unset
// fallback unambiguous) is Settings refusing to hide the last visible control,
// asserted in `tests/settings/toolbarCustomize.test.tsx`.
describe("resolveToolbarHidden", () => {
  it("empty stored value = unset → the default hidden set", () => {
    expect(resolveToolbarHidden([])).toEqual([...EDITOR_TOOLBAR_DEFAULT_HIDDEN]);
  });

  it("a stored value that reveals a formerly-pending id IS honoured", () => {
    const stored = EDITOR_TOOLBAR_DEFAULT_HIDDEN.filter((id) => id !== "quote");
    const shown = resolveToolbarOrder([], resolveToolbarHidden(stored));
    expect(shown).toContain("quote");
  });

  it("de-duplicates a stored value", () => {
    const resolved = resolveToolbarHidden(["italic", "italic", "quote"]);
    expect(resolved.filter((x) => x === "italic")).toHaveLength(1);
    expect(resolved).toContain("quote");
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
