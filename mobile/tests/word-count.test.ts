import { describe, it, expect } from "vitest";
import { countWords } from "../src/lib/word-count";

describe("countWords()", () => {
  it("returns zero words / zero reading time for empty or whitespace-only text", () => {
    expect(countWords("")).toEqual({ words: 0, chars: 0, readingMinutes: 0 });
    expect(countWords("   \n\t ")).toEqual({ words: 0, chars: 6, readingMinutes: 0 });
  });

  it("counts whitespace-separated word runs", () => {
    expect(countWords("hello world")).toMatchObject({ words: 2, chars: 11 });
    expect(countWords("  one   two\tthree\nfour ")).toMatchObject({ words: 4 });
  });

  it("counts characters as the raw length", () => {
    expect(countWords("abc").chars).toBe(3);
  });

  it("estimates reading time at ~200 wpm, rounded up", () => {
    expect(countWords("a ".repeat(1)).readingMinutes).toBe(1); // 1 word → 1 min
    expect(countWords("a ".repeat(200)).readingMinutes).toBe(1); // 200 → 1 min
    expect(countWords("a ".repeat(201)).readingMinutes).toBe(2); // 201 → 2 min
  });
});
