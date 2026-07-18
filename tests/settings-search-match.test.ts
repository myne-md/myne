// Task 1 (settings-search) — accent fold + fold-aware matcher.
// Behaviour: foldAccents strips diacritics (Latin + Turkish) and is idempotent;
// matchHaystacks is case- AND accent-insensitive, matches title/description/
// keyword haystacks, returns [] on no match and all candidates on empty query,
// and reuses fuzzyFilter for scoring (verified by ordering).

import { describe, expect, it } from "vitest";
import { foldAccents } from "../src/components/settings/search/foldAccents";
import { matchHaystacks } from "../src/components/settings/search/matchSettings";

describe("foldAccents", () => {
  it("strips Turkish + Latin diacritics", () => {
    expect(foldAccents("görünüm")).toBe("gorunum");
    expect(foldAccents("Otomatik kilit é")).toBe("Otomatik kilit e");
    expect(foldAccents("Ölçü")).toBe("Olcu");
    expect(foldAccents("çıktı")).toBe("cıktı"); // ç→c, but dotless-ı stays
  });

  it("preserves letter-identity chars that are not diacritics (Turkish dotless-ı)", () => {
    // NFD accent-folding is deliberately not case/letter folding: U+0131 (ı) is
    // its own base letter, not i + a combining mark, so it is left intact. This
    // marks the accepted boundary of "accent-insensitive".
    expect(foldAccents("kısayol")).toBe("kısayol");
  });

  it("leaves casing alone (fuzzyFilter lowercases downstream)", () => {
    expect(foldAccents("Görünüm")).toBe("Gorunum");
  });

  it("is idempotent on already-folded input", () => {
    const once = foldAccents("Görünüm ölçü");
    expect(foldAccents(once)).toBe(once);
  });
});

type Row = { id: string };
const INDEX: { item: Row; haystacks: string[] }[] = [
  { item: { id: "theme" }, haystacks: ["Theme", "Switch between light and dark", "dark light mode appearance"] },
  { item: { id: "autolock" }, haystacks: ["Auto-lock", "Lock the vault after inactivity", "timeout idle timer"] },
  { item: { id: "view" }, haystacks: ["Görünüm", "Default view mode", "live reading source"] },
];

describe("matchHaystacks", () => {
  it("matches on the title", () => {
    const ids = matchHaystacks(INDEX, "theme").map((m) => m.item.id);
    expect(ids).toContain("theme");
  });

  it("matches on the description", () => {
    const ids = matchHaystacks(INDEX, "inactivity").map((m) => m.item.id);
    expect(ids).toEqual(["autolock"]);
  });

  it("matches on a keyword/synonym not in the title", () => {
    const ids = matchHaystacks(INDEX, "dark").map((m) => m.item.id);
    expect(ids).toContain("theme");
  });

  it("is case-insensitive", () => {
    expect(matchHaystacks(INDEX, "THEME").map((m) => m.item.id)).toContain("theme");
  });

  it("is accent-insensitive both directions", () => {
    // query without accents matches an accented haystack…
    expect(matchHaystacks(INDEX, "gorunum").map((m) => m.item.id)).toContain("view");
    // …and an accented query matches too.
    expect(matchHaystacks(INDEX, "görünüm").map((m) => m.item.id)).toContain("view");
  });

  it("returns [] when nothing matches", () => {
    expect(matchHaystacks(INDEX, "zzzzznope")).toEqual([]);
  });

  it("returns all candidates for an empty/whitespace query", () => {
    expect(matchHaystacks(INDEX, "").length).toBe(INDEX.length);
    expect(matchHaystacks(INDEX, "   ").length).toBe(INDEX.length);
  });

  it("orders exact-ish matches ahead (scored by fuzzyFilter)", () => {
    // 'auto-lock' is a prefix/exact-ish hit for 'auto'; 'timeout' only appears
    // as a keyword. Both match; the title hit should not rank below nothing.
    const res = matchHaystacks(INDEX, "auto");
    expect(res[0].item.id).toBe("autolock");
  });
});
