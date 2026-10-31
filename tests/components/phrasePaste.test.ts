// @vitest-environment jsdom
//
// Whole-phrase pasting into the desktop four-box step (myne-md/myne#945 item 02).
//
// The helper is worth its own file for one reason the review named: its only
// coverage was a guard asserting the component imports and calls it, so a body
// replaced by `return null` left the whole suite green while paste silently
// stopped working. A pasted recovery phrase is the one flow where "nothing
// happened" is indistinguishable from "the phrase was wrong", and the user's
// next move is to retype 24 words.
//
// The three inputs that decide an outcome, and what each one means:
//   - a string with fewer words than the highest box asks for: the phrase is
//     short, so the caller must not write it (null),
//   - a string whose words cover the boxes: each box gets its word (the map),
//   - a string with no words at all: nothing to distribute (null).

import { describe, expect, it } from "vitest";

import { distributePhrasePaste } from "../../src/components/PhraseTypeBack";

describe("distributePhrasePaste", () => {
  it("splits a whole phrase into the boxes that asked for it", () => {
    // The real shape: four boxes, words 7, 11, 19 and 23 of the phrase.
    const positions = [7, 11, 19, 23];
    const words = Array.from({ length: 24 }, (_, i) => `w${i + 1}`);
    expect(distributePhrasePaste(words.join(" "), positions)).toEqual([
      [7, "w7"],
      [11, "w11"],
      [19, "w19"],
      [23, "w23"],
    ]);
  });

  it("normalises the whitespace a paste carries, including a line break", () => {
    // A phrase copied out of a note arrives with newlines and a trailing space.
    const words = Array.from({ length: 24 }, (_, i) => `w${i + 1}`);
    const pasted = `  ${words.slice(0, 11).join("\n")} \n`;
    expect(distributePhrasePaste(pasted, [7, 11])).toEqual([
      [7, "w7"],
      [11, "w11"],
    ]);
  });

  it("refuses a phrase shorter than the highest box", () => {
    // Writing the first three boxes and leaving the fourth empty would be worse
    // than refusing: the caller's error line would blame the user's phrase for
    // what was a truncated copy.
    expect(distributePhrasePaste("a b c", [1, 2, 3, 4])).toBeNull();
  });

  it("refuses an empty or whitespace-only paste", () => {
    expect(distributePhrasePaste("", [1])).toBeNull();
    expect(distributePhrasePaste("   \n\t ", [1])).toBeNull();
  });

  it("accepts a phrase with exactly as many words as the highest box", () => {
    const words = Array.from({ length: 24 }, (_, i) => `w${i + 1}`);
    expect(distributePhrasePaste(words.join(" "), [24])).toEqual([[24, "w24"]]);
  });

  it("keeps a box whose word is missing empty rather than dropping the box", () => {
    // Only reachable through positions that skip: the map must still name every
    // box the caller passed, because the caller clears each one it does not set.
    const words = Array.from({ length: 24 }, (_, i) => `w${i + 1}`);
    const out = distributePhrasePaste(words.slice(0, 12).join(" "), [3, 12, 20]);
    // 20 is above the words given, so the whole paste is refused instead of
    // writing a hole into box 20.
    expect(out).toBeNull();
    expect(distributePhrasePaste(words.slice(0, 12).join(" "), [3, 12])).toEqual([
      [3, "w3"],
      [12, "w12"],
    ]);
  });
});
