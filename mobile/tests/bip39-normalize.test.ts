import { describe, it, expect } from "vitest";
import { normalizeBip39Phrase } from "../src/lib/bip39-normalize";

describe("normalizeBip39Phrase()", () => {
  it("lowercases and trims", () => {
    expect(normalizeBip39Phrase("  Abandon ABILITY  ")).toBe("abandon ability");
  });

  it("collapses internal whitespace runs to a single ASCII space", () => {
    expect(normalizeBip39Phrase("abandon\t\tability\n able")).toBe("abandon ability able");
  });

  it("NFKD-normalizes composed characters", () => {
    // U+00E9 (é, composed) normalizes to "e" + U+0301 (combining acute).
    const composed = "café";
    const out = normalizeBip39Phrase(composed);
    expect(out).toBe("café");
  });

  it("is idempotent on already-normalized input", () => {
    const once = normalizeBip39Phrase("ribbon kernel voyage");
    expect(normalizeBip39Phrase(once)).toBe(once);
  });
});
