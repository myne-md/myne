// The recovery-phrase type-back challenge's shared draw, `@myne/client-core/phrase-challenge`
// (myne-md/myne#851), and the desktop adapter over it.
//
// ## Why the DRAW has an assertion here and not only "four in range"
//
// The draw is biased on purpose: one word from each third of a 24-word phrase. The bias is
// what detects a partial write-down, since only a user who wrote the last third down can
// answer a last-third position. Mobile drew four UNIFORM positions until #851, which is a
// draw that satisfies every structural assertion a client could make about its own challenge
// (four positions, distinct, in range, sorted) and still gives up the last-third guarantee on
// about one screen in six. So the assertion below is not "the draw is well-formed": it is
// "the draw is one-from-each-third on EVERY draw", which the uniform draw fails on most runs
// rather than only on an unlucky one.
//
// The loop bound is a sample, not a proof, and it is chosen so the direction of the error is
// safe: a correct implementation satisfies the invariant on all 2000 draws with probability 1,
// while the uniform one violates it in about 17% of draws (no position in the last third) or
// 41% (fewer than two in the middle), so a revert cannot pass by luck.
//
// `mobile/tests/phraseChallenge.test.ts` carries the same invariant for the mobile adapter,
// one net per lane, because the two suites run in separate CI steps and a lane whose only
// guard lives in the other lane's suite is a lane with no guard.

import { describe, expect, it } from "vitest";
import {
  drawPhraseChallenge,
  normalizePhraseWord,
  PHRASE_WORD_COUNT,
} from "@myne/client-core/phrase-challenge";
import {
  drawConfirmPositions,
  normalizeWord,
} from "../../src/screens/vault-creation/reducer";

const DRAWS = 2000;

/** True when `p` is in the 1-based third `[lo, hi]` inclusive. */
const inThird = (p: number, lo: number, hi: number) => p >= lo && p <= hi;

describe("drawPhraseChallenge (shared rule)", () => {
  it("takes one word from each third of a 24-word phrase, on every draw", () => {
    const violations: Array<readonly number[]> = [];
    for (let i = 0; i < DRAWS; i++) {
      const [a, b, c, d] = drawPhraseChallenge();
      const oneFromEachThird =
        inThird(a, 0, 7) && inThird(b, 8, 15) && inThird(c, 8, 15) && inThird(d, 16, 23);
      if (!oneFromEachThird) violations.push([a, b, c, d]);
    }
    expect(
      violations.length,
      `draws that did not take one word from each third: ${JSON.stringify(violations.slice(0, 5))}`,
    ).toBe(0);
  });

  it("returns four distinct positions, ascending, inside the phrase", () => {
    for (let i = 0; i < DRAWS; i++) {
      const draw = drawPhraseChallenge();
      expect(new Set(draw).size).toBe(4);
      expect([...draw].sort((x, y) => x - y)).toEqual([...draw]);
      for (const p of draw) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThan(PHRASE_WORD_COUNT);
      }
    }
  });

  it("is defined for a 24-word phrase specifically", () => {
    // The bias is stated in thirds, so a 12-word flow owes its own rule rather than a
    // parameter here. Pinning the constant keeps a caller from assuming otherwise.
    expect(PHRASE_WORD_COUNT).toBe(24);
  });
});

describe("the desktop adapter over the shared draw", () => {
  it("drawConfirmPositions is the shared draw mapped to 1-based", () => {
    const violations: Array<readonly number[]> = [];
    for (let i = 0; i < DRAWS; i++) {
      const [a, b, c, d] = drawConfirmPositions();
      const oneFromEachThird =
        inThird(a, 1, 8) && inThird(b, 9, 16) && inThird(c, 9, 16) && inThird(d, 17, 24);
      if (!oneFromEachThird) violations.push([a, b, c, d]);
    }
    expect(
      violations.length,
      `1-based draws that did not take one word from each third: ${JSON.stringify(violations.slice(0, 5))}`,
    ).toBe(0);
  });
});

describe("normalizePhraseWord", () => {
  it("folds case and surrounding whitespace, and NFKD-normalises accents", () => {
    expect(normalizePhraseWord("  INCOME \n")).toBe("income");
    // A decomposed accent is the same word to a reader as a precomposed one.
    expect(normalizePhraseWord("é")).toBe(normalizePhraseWord("é"));
  });

  it("is the one implementation, re-exported under the name each client uses", () => {
    // `normalizeWord` is the desktop name (re-exported by the reducer, and by the
    // vault-creation barrel); the mobile module re-exports the same binding. If either
    // client grows its own copy again, this identity goes.
    expect(normalizeWord).toBe(normalizePhraseWord);
  });
});
