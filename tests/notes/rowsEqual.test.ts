// `rowsEqual` — the identity-stable guard for the vault-wide picker sets
// (`useVaultHeadings`, `useVaultBlockAnchors`).
//
// Both hooks refetch on the SYNC-5 index nonce, which every autosave bumps.
// Without this guard each refetch allocated a fresh rows array, so the hook
// returned a new identity, so the editor reconfigured and every consumer
// re-rendered on every save (the long-note flicker).

import { describe, expect, it } from "vitest";

import { rowsEqual } from "../../src/notes/rowsEqual";

type Row = { noteId: string; text: string; level: number };
const KEYS = ["noteId", "text", "level"] as const;

describe("rowsEqual", () => {
  it("treats same-reference arrays as equal", () => {
    const a: Row[] = [{ noteId: "n1", text: "H", level: 1 }];
    expect(rowsEqual(a, a, KEYS)).toBe(true);
  });

  it("treats field-identical fresh arrays as equal (the save case)", () => {
    const a: Row[] = [{ noteId: "n1", text: "H", level: 1 }];
    const b: Row[] = [{ noteId: "n1", text: "H", level: 1 }];
    expect(rowsEqual(a, b, KEYS)).toBe(true);
  });

  it("detects a changed field", () => {
    const a: Row[] = [{ noteId: "n1", text: "H", level: 1 }];
    const b: Row[] = [{ noteId: "n1", text: "H2", level: 1 }];
    expect(rowsEqual(a, b, KEYS)).toBe(false);
  });

  it("detects a length change", () => {
    const a: Row[] = [{ noteId: "n1", text: "H", level: 1 }];
    const b: Row[] = [
      { noteId: "n1", text: "H", level: 1 },
      { noteId: "n2", text: "I", level: 2 },
    ];
    expect(rowsEqual(a, b, KEYS)).toBe(false);
  });

  it("detects a reorder", () => {
    const a: Row[] = [
      { noteId: "n1", text: "H", level: 1 },
      { noteId: "n2", text: "I", level: 2 },
    ];
    const b: Row[] = [
      { noteId: "n2", text: "I", level: 2 },
      { noteId: "n1", text: "H", level: 1 },
    ];
    expect(rowsEqual(a, b, KEYS)).toBe(false);
  });

  it("treats two empty arrays as equal", () => {
    expect(rowsEqual([], [], KEYS)).toBe(true);
  });
});
