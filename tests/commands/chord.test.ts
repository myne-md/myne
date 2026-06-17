// Chord normalization + lookup for the window-level keybind engine (MYND-304).
// Pins event→chord canonicalization (platform split, shifted-letter lowercasing,
// punctuation, literal Ctrl, bare-modifier → null), stored-chord normalization
// (modifier reorder + key lowercase + literal "-" + "Mod-,"), and chord→command
// lookup incl. the multi-match (conflict) case.

import { describe, it, expect } from "vitest";
import {
  eventToChord,
  normalizeChord,
  commandIdsForChord,
  formatChord,
} from "../../src/commands/chord";

describe("eventToChord", () => {
  it("maps the platform accelerator to Mod (mac=Meta, other=Ctrl)", () => {
    expect(eventToChord({ key: "k", metaKey: true }, true)).toBe("Mod-k");
    expect(eventToChord({ key: "k", ctrlKey: true }, false)).toBe("Mod-k");
  });

  it("lowercases a shifted letter and keeps Shift as a modifier (Mod-Shift-g)", () => {
    expect(eventToChord({ key: "G", metaKey: true, shiftKey: true }, true)).toBe(
      "Mod-Shift-g",
    );
  });

  it("preserves punctuation keys (Mod-,)", () => {
    expect(eventToChord({ key: ",", metaKey: true }, true)).toBe("Mod-,");
  });

  it("represents a literal Ctrl on macOS as Ctrl, distinct from Mod", () => {
    expect(eventToChord({ key: "Tab", ctrlKey: true }, true)).toBe("Ctrl-Tab");
  });

  it("orders modifiers Mod, Alt, Shift before the key", () => {
    expect(
      eventToChord({ key: "ArrowLeft", metaKey: true, altKey: true }, true),
    ).toBe("Mod-Alt-ArrowLeft");
  });

  it("returns null for a bare modifier press", () => {
    expect(eventToChord({ key: "Shift", shiftKey: true }, true)).toBeNull();
    expect(eventToChord({ key: "Meta", metaKey: true }, true)).toBeNull();
  });
});

describe("normalizeChord", () => {
  it("is identity on an already-canonical chord", () => {
    expect(normalizeChord("Mod-Shift-g")).toBe("Mod-Shift-g");
    expect(normalizeChord("Mod-,")).toBe("Mod-,");
    expect(normalizeChord("Ctrl-Tab")).toBe("Ctrl-Tab");
  });

  it("reorders modifiers and lowercases the key", () => {
    expect(normalizeChord("Shift-Mod-G")).toBe("Mod-Shift-g");
    expect(normalizeChord("Alt-Mod-k")).toBe("Mod-Alt-k");
  });

  it("handles a literal '-' key (trailing dash not split)", () => {
    expect(normalizeChord("Mod--")).toBe("Mod--");
  });

  it("throws on an unrecognized modifier token", () => {
    expect(() => normalizeChord("Hyper-x")).toThrow();
  });
});

describe("formatChord", () => {
  it("renders mac glyphs joined tight, matching the prior kbd literals", () => {
    expect(formatChord("Mod-Shift-g", true)).toBe("⌘⇧G");
    expect(formatChord("Mod-,", true)).toBe("⌘,");
    expect(formatChord("Mod-Alt-ArrowLeft", true)).toBe("⌘⌥←");
  });

  it("renders words joined with + on non-mac (Mod → Ctrl)", () => {
    expect(formatChord("Mod-Shift-g", false)).toBe("Ctrl+Shift+G");
    expect(formatChord("Mod-,", false)).toBe("Ctrl+,");
  });

  it("normalizes input before formatting (reorder + lowercase)", () => {
    expect(formatChord("Shift-Mod-g", true)).toBe("⌘⇧G");
  });
});

describe("commandIdsForChord", () => {
  it("finds the command bound to a chord (normalizing both sides)", () => {
    const effective = { "graph.show": ["Mod-Shift-g"], "app.command-palette": ["Mod-k"] };
    expect(commandIdsForChord("Shift-Mod-G", effective)).toEqual(["graph.show"]);
    expect(commandIdsForChord("Mod-k", effective)).toEqual(["app.command-palette"]);
  });

  it("returns [] when no command matches", () => {
    expect(commandIdsForChord("Mod-q", { "graph.show": ["Mod-Shift-g"] })).toEqual([]);
  });

  it("returns every match when two commands share a chord (conflict)", () => {
    const ids = commandIdsForChord("Mod-k", { a: ["Mod-k"], b: ["Mod-k"] });
    expect(ids.sort()).toEqual(["a", "b"]);
  });
});
