// Document statistics (MYND-339): chars / words / spaces / paragraphs over the
// dialect-stripped body, plus the pure `statsOfPlain` used for the selection.

import { describe, expect, it } from "vitest";
import { computeDocStats, statsOfPlain } from "../../src/notes/documentStats";
import { countBodyWords } from "../../src/notes/wordCount";

describe("statsOfPlain", () => {
  it("counts characters (incl. spaces), words, spaces, paragraphs", () => {
    expect(statsOfPlain("Hello world")).toEqual({
      characters: 11,
      words: 2,
      spaces: 1,
      paragraphs: 1,
    });
  });

  it("paragraphs are blank-line delimited", () => {
    const s = statsOfPlain("first line\nstill first\n\nsecond para");
    expect(s.paragraphs).toBe(2);
    expect(s.words).toBe(6);
  });

  it("collapses multiple blank lines to one separator", () => {
    expect(statsOfPlain("a\n\n\n\nb").paragraphs).toBe(2);
  });

  it("empty / whitespace-only → all zero", () => {
    expect(statsOfPlain("")).toEqual({ characters: 0, words: 0, spaces: 0, paragraphs: 0 });
    expect(statsOfPlain("   \n\n  ")).toEqual({
      characters: 0,
      words: 0,
      spaces: 0,
      paragraphs: 0,
    });
  });
});

describe("computeDocStats", () => {
  it("excludes frontmatter and strips markdown syntax", () => {
    const note = "---\ntitle: T\n---\n\n**bold** word";
    const s = computeDocStats(note);
    // strips to "bold word" → 9 chars, 2 words, 1 space, 1 paragraph
    expect(s).toEqual({ characters: 9, words: 2, spaces: 1, paragraphs: 1 });
  });

  it("word count matches countBodyWords (parity preserved)", () => {
    const note = "---\ntitle: T\n---\n\nalpha beta\n\ngamma **delta**";
    expect(computeDocStats(note).words).toBe(countBodyWords(note));
  });

  it("empty note → all zero", () => {
    expect(computeDocStats("")).toEqual({
      characters: 0,
      words: 0,
      spaces: 0,
      paragraphs: 0,
    });
  });

  // `%%…%%` dialect comments are dialect-hidden, so document statistics exclude
  // them from all four counts (SYNC-1, MYND-315) — matching what renders /
  // exports. The same body WITHOUT the comment must count identically.
  it("excludes inline `%%…%%` comments from all four stats", () => {
    const withComment = "alpha %%a hidden note to self%% beta";
    const withoutComment = "alpha  beta"; // the comment span removed in place
    expect(computeDocStats(withComment)).toEqual(
      computeDocStats(withoutComment),
    );
    // And the comment words ("hidden", "note", …) don't inflate the count.
    expect(computeDocStats(withComment).words).toBe(2);
  });

  it("excludes a multi-line block `%%`…`%%` comment from the stats", () => {
    const note = "visible para\n\n%% block\ncomment lines %%\n\ntail para";
    const s = computeDocStats(note);
    // Only the two visible paragraphs survive.
    expect(s.paragraphs).toBe(2);
    expect(s.words).toBe(4); // "visible para tail para"
  });

  it("an UNTERMINATED `%%` still counts (it is inert, not a comment)", () => {
    const note = "alpha %% not a comment beta";
    // No comment node → the `%%` and following words count as ordinary text.
    expect(computeDocStats(note).words).toBe(6);
  });
});
