// Effective-binding read-API tests (hotkeys epic, MYND-304; SYNC-4). Pins the
// override ?? default resolution incl. the empty-array explicit-unbind, and
// that the read API is the single binding source (never the display `kbd`).

import { describe, it, expect } from "vitest";
import { effectiveBinding, effectiveKeymap } from "../../src/commands/keymap";

const settings = { id: "app.open-settings", defaultBinding: "Mod-," };
const graph = { id: "graph.show", defaultBinding: "Mod-Shift-g" };
const noDefault = { id: "vault.lock", defaultBinding: undefined };

describe("effectiveBinding", () => {
  it("returns the in-code default when there is no override", () => {
    expect(effectiveBinding(settings, {})).toEqual(["Mod-,"]);
    expect(effectiveBinding(graph, {})).toEqual(["Mod-Shift-g"]);
  });

  it("returns an empty array when there is neither override nor default", () => {
    expect(effectiveBinding(noDefault, {})).toEqual([]);
  });

  it("returns the user override (single or multi) over the default", () => {
    expect(effectiveBinding(graph, { "graph.show": ["Mod-g"] })).toEqual(["Mod-g"]);
    expect(
      effectiveBinding(settings, { "app.open-settings": ["Mod-,", "Alt-s"] }),
    ).toEqual(["Mod-,", "Alt-s"]);
  });

  it("honors an empty-array override as an explicit unbind (not the default)", () => {
    // The [] override means the user removed the shortcut — it must NOT fall
    // back to the default chord.
    expect(effectiveBinding(graph, { "graph.show": [] })).toEqual([]);
  });

  it("an override for a different command does not affect this one", () => {
    expect(effectiveBinding(graph, { "app.open-settings": ["Mod-x"] })).toEqual([
      "Mod-Shift-g",
    ]);
  });
});

describe("effectiveKeymap", () => {
  it("projects command-id → effective chords across the set", () => {
    const map = effectiveKeymap([settings, graph, noDefault], {
      "graph.show": ["Mod-g"], // override
      "vault.lock": [], // explicit unbind on a no-default command
    });
    expect(map).toEqual({
      "app.open-settings": ["Mod-,"], // default
      "graph.show": ["Mod-g"], // override
      "vault.lock": [], // explicit unbind
    });
  });
});
