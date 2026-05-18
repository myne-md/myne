// Fuzzy matcher pure-logic tests — covers `src/commands/fuzzy.ts` used by
// both the slash menu and the command palette (MYND-86).

import { describe, expect, it } from "vitest";
import { fuzzyFilter, type FuzzyCandidate } from "../../src/commands/fuzzy";

type Item = { id: string; label: string };

function build(items: ReadonlyArray<Item>): FuzzyCandidate<Item>[] {
  return items.map((i) => ({ item: i, haystacks: [i.label, i.id] }));
}

const SAMPLE: Item[] = [
  { id: "vault.lock", label: "Lock vault" },
  { id: "app.open-settings", label: "Open settings…" },
  { id: "note.switch", label: "Switch to note…" },
  { id: "vault.import-obsidian", label: "Import Obsidian vault…" },
  { id: "wikilinks.convert-in-this-note", label: "Convert wikilinks in this note…" },
];

describe("fuzzyFilter", () => {
  it("empty query returns all candidates in original order with score 1", () => {
    const matches = fuzzyFilter(build(SAMPLE), "");
    expect(matches.length).toBe(SAMPLE.length);
    expect(matches[0]!.item.id).toBe("vault.lock");
    expect(matches.every((m) => m.score === 1)).toBe(true);
  });

  it("prefix match scores 500 (higher than substring)", () => {
    // "lock" prefix matches the label "Lock vault" → 500.
    // "lock" is also a substring of "vault.lock" id → 100.
    // Prefix wins on label haystack.
    const matches = fuzzyFilter(build(SAMPLE), "lock");
    expect(matches[0]!.item.id).toBe("vault.lock");
    expect(matches[0]!.score).toBe(500);
  });

  it("case-insensitive", () => {
    const a = fuzzyFilter(build(SAMPLE), "OPEN");
    const b = fuzzyFilter(build(SAMPLE), "open");
    expect(a[0]!.item.id).toBe(b[0]!.item.id);
  });

  it("exact match scores 1000 (top of ranking)", () => {
    const candidates: FuzzyCandidate<Item>[] = [
      { item: { id: "a", label: "lock" }, haystacks: ["lock"] },
      { item: { id: "b", label: "lock vault" }, haystacks: ["lock vault"] },
    ];
    const matches = fuzzyFilter(candidates, "lock");
    expect(matches[0]!.item.id).toBe("a");
    expect(matches[0]!.score).toBe(1000);
    expect(matches[1]!.item.id).toBe("b");
    expect(matches[1]!.score).toBe(500);
  });

  it("substring match scores at least 100", () => {
    // "obsidian" is a substring of "Import Obsidian vault…".
    const matches = fuzzyFilter(build(SAMPLE), "obsidian");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.item.id).toBe("vault.import-obsidian");
  });

  it("filters out non-matching items", () => {
    const matches = fuzzyFilter(build(SAMPLE), "xyzzy");
    expect(matches.length).toBe(0);
  });

  it("trims whitespace in query", () => {
    const a = fuzzyFilter(build(SAMPLE), "  lock  ");
    const b = fuzzyFilter(build(SAMPLE), "lock");
    expect(a[0]?.item.id).toBe(b[0]?.item.id);
  });

  it("word-boundary substring outranks plain substring", () => {
    // "obsidian" appears mid-word in "import-obsidian" (id) and after a
    // space in "Import Obsidian vault" (label). The word-boundary
    // detection (`" obsidian"`, `"-obsidian"`, `"/obsidian"`) bumps the
    // score above plain substring (100 → 200).
    const matches = fuzzyFilter(build(SAMPLE), "obsidian");
    expect(matches[0]!.score).toBeGreaterThanOrEqual(200);
  });
});
