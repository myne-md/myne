import { describe, expect, it } from "vitest";
import { truncateMiddle } from "../../../src/notes/import/truncateMiddle";

describe("truncateMiddle", () => {
  it("returns short values unchanged", () => {
    expect(truncateMiddle("note.md", 64)).toBe("note.md");
    expect(truncateMiddle("", 64)).toBe("");
  });

  it("returns a value exactly at the cap unchanged", () => {
    const at = "a".repeat(64);
    expect(truncateMiddle(at, 64)).toBe(at);
  });

  it("middle-ellipsises an over-cap value to exactly `max` code points", () => {
    const long = "a".repeat(10_000);
    const out = truncateMiddle(long, 64);
    expect(Array.from(out)).toHaveLength(64);
    expect(out).toContain("…");
    expect(out.startsWith("a")).toBe(true);
    expect(out.endsWith("a")).toBe(true);
  });

  it("keeps a leading and trailing run so both ends stay matchable", () => {
    const out = truncateMiddle("HEAD" + "x".repeat(200) + "TAIL", 20);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toContain("…");
  });

  it("never splits a surrogate pair (astral characters)", () => {
    // 𝔞 (U+1D51E) is two UTF-16 units; a naive slice would emit a lone surrogate.
    const astral = "𝔞".repeat(200);
    const out = truncateMiddle(astral, 32);
    // No lone surrogate: re-encoding through code points is a round-trip.
    expect(Array.from(out).join("")).toBe(out);
    expect([...out].every((ch) => ch === "…" || ch === "𝔞")).toBe(true);
  });

  it("counts multibyte names by code point", () => {
    const multi = "é".repeat(500);
    const out = truncateMiddle(multi, 40);
    expect(Array.from(out)).toHaveLength(40);
  });

  it("clamps a tiny cap to leave room for the ellipsis", () => {
    const out = truncateMiddle("abcdef", 1);
    expect(out).toContain("…");
    expect(Array.from(out).length).toBeLessThanOrEqual(2);
  });
});
