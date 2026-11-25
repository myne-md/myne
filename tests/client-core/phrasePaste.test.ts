// SPDX-License-Identifier: AGPL-3.0-only
//
// The paste rule of `recovery-flow.md` §3.2, as one function instead of eleven
// copies (myne-md/myne#932).
//
// The defect this pins: every phrase surface distributed a paste from the cell
// it LANDED on, so a paste into cell 5 wrote the first twenty words into cells
// 5-24 and silently dropped the last four. The grid came out fully populated with
// a phrase nobody typed, and the submit gate ("all 24 cells non-empty") cannot
// tell that from the real thing. The user's only visible evidence was that the
// phrase was rejected, which reads as "my words are wrong".

import { describe, expect, it } from "vitest";
import {
  applyPastedPhrase,
  PHRASE_CELL_COUNT,
  phrasePasteTokens,
} from "../../client-core/src/phrase-cells";

const words = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `word${i + 1}`);

const empty = (): string[] => Array.from({ length: PHRASE_CELL_COUNT }, () => "");

describe("phrasePasteTokens", () => {
  it("splits on any whitespace run and drops the empties", () => {
    expect(phrasePasteTokens("  abandon\tability \n able  ")).toEqual([
      "abandon",
      "ability",
      "able",
    ]);
  });

  it("returns fewer than two tokens for a single word, which is not a distribution", () => {
    expect(phrasePasteTokens("abandon")).toEqual(["abandon"]);
    expect(phrasePasteTokens("   ")).toEqual([]);
  });
});

describe("applyPastedPhrase", () => {
  it("fills from the FIRST cell, whatever cell the paste landed on", () => {
    const tokens = words(24);
    const filled = applyPastedPhrase(empty(), tokens);
    expect(filled).toEqual(tokens);
    // The regression: distributing from cell 5 would leave cells 1-4 empty and
    // write `word1..word20` into cells 5-24.
    expect(filled[0]).toBe("word1");
    expect(filled[PHRASE_CELL_COUNT - 1]).toBe("word24");
  });

  it("overwrites stale words rather than appending after them", () => {
    const stale = Array.from({ length: PHRASE_CELL_COUNT }, () => "stale");
    const filled = applyPastedPhrase(stale, words(24));
    expect(filled.includes("stale")).toBe(false);
  });

  it("caps at the cell count, which is what §3.2 says a long paste does", () => {
    const filled = applyPastedPhrase(empty(), words(30));
    expect(filled).toHaveLength(PHRASE_CELL_COUNT);
    expect(filled[PHRASE_CELL_COUNT - 1]).toBe(`word${PHRASE_CELL_COUNT}`);
  });

  it("leaves cells past the token count alone: a short paste is visible state", () => {
    const typed = empty();
    typed[23] = "typed";
    const filled = applyPastedPhrase(typed, words(20));
    expect(filled[19]).toBe("word20");
    expect(filled[20]).toBe("");
    expect(filled[23]).toBe("typed");
  });

  it("never mutates the array it is given", () => {
    const cells = empty();
    applyPastedPhrase(cells, words(24));
    expect(cells.every((c) => c === "")).toBe(true);
  });
});
