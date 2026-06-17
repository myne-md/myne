// Conflict-detection predicate tests (MYND-304; SYNC-7 + SYNC-2 grill Q1).
// Pins containment-aware overlap, phase-distinct coexistence (Mod-[/]),
// stage-disjoint non-conflict, the per-note×global overlap, and the whole-
// keymap scan.

import { describe, it, expect } from "vitest";
import {
  conflictsFor,
  scopesOverlap,
  allConflicts,
  type ConflictDescriptor,
} from "../../src/commands/conflicts";

describe("scopesOverlap", () => {
  it("a wildcard (undefined) stage overlaps any stage", () => {
    expect(scopesOverlap({}, { stage: "editor" })).toBe(true);
    expect(scopesOverlap({ stage: "editor" }, {})).toBe(true);
  });

  it("two different explicit stages are disjoint", () => {
    expect(scopesOverlap({ stage: "editor" }, { stage: "unlock" })).toBe(false);
  });

  it("per-note vs global still overlap (a note-selected context fires both)", () => {
    expect(scopesOverlap({ requiresNote: true }, {})).toBe(true);
  });
});

describe("conflictsFor", () => {
  const descriptors: ConflictDescriptor[] = [
    { id: "graph.show", scope: {} },
    { id: "app.command-palette", scope: {} },
    { id: "nav.back", scope: {}, phase: "capture" },
    { id: "note.snapshots", scope: { requiresNote: true } },
  ];

  it("flags a different command bound to the same chord (same phase + overlap)", () => {
    const km = { "graph.show": ["Mod-k"], "app.command-palette": ["Mod-k"] };
    expect(conflictsFor("Mod-k", "graph.show", descriptors, km)).toEqual([
      "app.command-palette",
    ]);
  });

  it("does not flag the command against itself", () => {
    const km = { "graph.show": ["Mod-k"] };
    expect(conflictsFor("Mod-k", "graph.show", descriptors, km)).toEqual([]);
  });

  it("does NOT flag a same-chord pair in different phases (Mod-[ capture vs bubble)", () => {
    // nav.back is capture; a bubble command on Mod-[ does not conflict with it.
    const km = { "nav.back": ["Mod-["], "graph.show": ["Mod-["] };
    expect(conflictsFor("Mod-[", "graph.show", descriptors, km)).toEqual([]);
  });

  it("flags a per-note × global same-chord pair (overlap exists when a note is open)", () => {
    const km = { "note.snapshots": ["Mod-j"], "graph.show": ["Mod-j"] };
    expect(conflictsFor("Mod-j", "note.snapshots", descriptors, km).sort()).toEqual([
      "graph.show",
    ]);
  });

  it("normalizes both sides (Shift-Mod-G matches Mod-Shift-g)", () => {
    const km = { "graph.show": ["Mod-Shift-g"], "app.command-palette": ["Shift-Mod-G"] };
    expect(conflictsFor("mod-shift-g", "graph.show", descriptors, km)).toEqual([
      "app.command-palette",
    ]);
  });

  it("returns [] when the chord is unique", () => {
    const km = { "graph.show": ["Mod-k"], "app.command-palette": ["Mod-p"] };
    expect(conflictsFor("Mod-k", "graph.show", descriptors, km)).toEqual([]);
  });
});

describe("allConflicts", () => {
  it("reports every command in a conflicting chord group", () => {
    const descriptors: ConflictDescriptor[] = [
      { id: "a", scope: {} },
      { id: "b", scope: {} },
      { id: "c", scope: {} },
    ];
    const km = { a: ["Mod-k"], b: ["Mod-k"], c: ["Mod-p"] };
    const conflicts = allConflicts(descriptors, km);
    expect(conflicts.a).toEqual(["b"]);
    expect(conflicts.b).toEqual(["a"]);
    expect(conflicts.c).toBeUndefined();
  });
});
