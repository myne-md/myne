// Rebind capture validity tests (MYND-304; rebind-flow grill Q1). Pins the
// ≥1-real-modifier rule, the F-key modifier-free exception, Shift-alone
// rejection, bare-modifier "still capturing", and capture from an event.

import { describe, it, expect } from "vitest";
import {
  isValidBindableChord,
  captureChordFromEvent,
  invalidChordReason,
} from "../../src/commands/capture";

describe("isValidBindableChord", () => {
  it("accepts a chord with a real modifier", () => {
    expect(isValidBindableChord("Mod-k")).toBe(true);
    expect(isValidBindableChord("Mod-Shift-g")).toBe(true);
    expect(isValidBindableChord("Alt-Enter")).toBe(true);
    expect(isValidBindableChord("Ctrl-Tab")).toBe(true);
  });

  it("accepts a modifier-free F-key", () => {
    expect(isValidBindableChord("F2")).toBe(true);
    expect(isValidBindableChord("F12")).toBe(true);
  });

  it("rejects a bare key", () => {
    expect(isValidBindableChord("a")).toBe(false);
    expect(isValidBindableChord("Enter")).toBe(false);
  });

  it("rejects Shift alone (Shift is not a real modifier)", () => {
    expect(isValidBindableChord("Shift-a")).toBe(false);
  });
});

describe("captureChordFromEvent", () => {
  it("returns the canonical chord for a valid combination", () => {
    const r = captureChordFromEvent({ key: "G", metaKey: true, shiftKey: true }, true);
    expect(r).toEqual({ ok: true, chord: "Mod-Shift-g" });
  });

  it("rejects a bare key with the invalid-chord reason", () => {
    const r = captureChordFromEvent({ key: "a" }, true);
    expect(r).toEqual({ ok: false, reason: invalidChordReason() });
  });

  it("treats a bare modifier as 'still capturing' (empty reason, not invalid copy)", () => {
    const r = captureChordFromEvent({ key: "Shift", shiftKey: true }, true);
    expect(r).toEqual({ ok: false, reason: "" });
  });
});
