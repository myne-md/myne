// The mobile type-back challenge's shared rule (myne-md/myne#855). Both mobile
// flows that show a 24-word phrase now draw four positions and gate on the
// answers; this pins the rule they share, so a change to it cannot silently make
// one flow's gate weaker than the other's.
//
// The DRAW itself moved to `@myne/client-core/phrase-challenge` in
// myne-md/myne#851, shared with desktop, and `pickChallenge` is the mobile adapter
// over it. The third assertion below is the one that catches a regression to the
// old UNIFORM draw mobile used to have, which satisfied every structural assertion
// here and still lost the last-third guarantee on about one screen in six: see the
// shared module's header, and `tests/lib/phraseChallenge.test.ts` for the same
// invariant on the desktop side.
import { describe, expect, it } from "vitest";
import {
  normalizeWord,
  phraseTypeBackMatches,
  pickChallenge,
} from "../src/lib/phraseChallenge";

const PHRASE = Array.from({ length: 24 }, (_, i) => `word${String(i + 1).padStart(2, "0")}`);

describe("phraseChallenge", () => {
  it("draws four distinct, sorted positions inside the phrase, one from each third", () => {
    const offThird: number[][] = [];
    for (let n = 0; n < 200; n += 1) {
      const challenge = pickChallenge();
      expect(challenge).toHaveLength(4);
      expect(new Set(challenge).size).toBe(4);
      for (const pos of challenge) {
        expect(pos).toBeGreaterThanOrEqual(0);
        expect(pos).toBeLessThan(24);
      }
      expect([...challenge].sort((a, b) => a - b)).toEqual(challenge);

      const [a, b, c, d] = challenge;
      const oneFromEachThird = a < 8 && b >= 8 && b < 16 && c >= 8 && c < 16 && d >= 16;
      if (!oneFromEachThird) offThird.push(challenge);
    }
    expect(
      offThird.length,
      `draws that did not take one word from each third: ${JSON.stringify(offThird.slice(0, 5))}`,
    ).toBe(0);
  });

  it("normalizes NFKD, case and surrounding whitespace", () => {
    expect(normalizeWord("  INCOME \n")).toBe("income");
    // A combining acute and a precomposed one are the same word.
    expect(normalizeWord("e\u0301")).toBe(normalizeWord("\u00e9"));
  });

  it("counts a field only once something is typed, and gates on all four", () => {
    const positions = [0, 5, 12, 23];

    const empty = phraseTypeBackMatches(PHRASE, positions, ["", "", "", ""]);
    expect(empty.matches).toEqual([null, null, null, null]);
    expect(empty.allCorrect).toBe(false);

    const three = phraseTypeBackMatches(PHRASE, positions, [
      PHRASE[0],
      PHRASE[5],
      PHRASE[12],
      "",
    ]);
    expect(three.matches[3]).toBeNull();
    expect(three.allCorrect).toBe(false);

    const wrong = phraseTypeBackMatches(PHRASE, positions, [
      PHRASE[0],
      "zoo",
      PHRASE[12],
      PHRASE[23],
    ]);
    expect(wrong.matches[1]).toBe(false);
    expect(wrong.allCorrect).toBe(false);

    const ok = phraseTypeBackMatches(PHRASE, positions, [
      " WORD01 ",
      PHRASE[5],
      PHRASE[12].toUpperCase(),
      PHRASE[23],
    ]);
    expect(ok.matches).toEqual([true, true, true, true]);
    expect(ok.allCorrect).toBe(true);
  });

  it("is never correct before a challenge has been drawn", () => {
    expect(phraseTypeBackMatches(PHRASE, [], []).allCorrect).toBe(false);
  });
});
