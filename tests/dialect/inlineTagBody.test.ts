// `isTagBody` answers §3.7.2's deny-list for a whole string, the same predicate
// the inline tokenizer scans with (myne-md/myne#1025).
//
// This exists because a surface PROPOSING a tag (the suggestion band) has to
// answer exactly what the parser would accept, and the alternative (a second
// strip list written against the shapes a model happened to emit) is how a chip
// came to offer `(#Writing with Markdown`. The tag charset was normative and
// correct all along; nothing asked it this question outside the tokenizer.
//
// The dialect vectors pin where a body STOPS for `(`, `)`, `+`, `#` and
// whitespace, and nothing else. The other twenty-odd characters the deny-list
// names are restated here as a table, which fails when a character stops being
// denied, and that is the direction that matters.

import { describe, expect, it } from "vitest";

import { isTagBody } from "../../src/dialect/lezer/inline-tag";

/** Every ASCII code point §3.7.2 denies. `#` is included: it is the marker, and
 *  a body cannot carry one either. */
const DENIED_ASCII = [
  "'",
  "!",
  '"',
  "#",
  "$",
  "%",
  "&",
  "(",
  ")",
  "*",
  "+",
  ",",
  ".",
  ":",
  ";",
  "<",
  "=",
  ">",
  "?",
  "@",
  "^",
  "`",
  "{",
  "|",
  "}",
  "~",
  "[",
  "]",
  "\\",
];

describe("isTagBody", () => {
  it("rejects every ASCII character the spec's deny-list names", () => {
    // The roster is pinned: a loop over an emptied or shrunken table passes
    // trivially, and this table is the only measurement of most of these
    // characters (the vectors cover five of them).
    expect(DENIED_ASCII).toHaveLength(29);
    for (const ch of DENIED_ASCII) {
      expect(isTagBody(`a${ch}b`), JSON.stringify(ch)).toBe(false);
      expect(isTagBody(ch), JSON.stringify(ch)).toBe(false);
    }
  });

  it("rejects the two Unicode punctuation blocks", () => {
    expect(isTagBody("a\u2013b")).toBe(false); // EN DASH, U+2000 through U+206F
    expect(isTagBody("a\u201cb")).toBe(false); // LEFT DOUBLE QUOTE, same block
    expect(isTagBody("a\u2e41b")).toBe(false); // U+2E00 through U+2E7F
  });

  it("rejects whitespace, including a tag made only of it", () => {
    expect(isTagBody("two words")).toBe(false);
    expect(isTagBody("two\twords")).toBe(false);
    expect(isTagBody("two\nwords")).toBe(false);
    expect(isTagBody("   ")).toBe(false);
    expect(isTagBody("")).toBe(false);
  });

  it("accepts letters, digits, `_`, `-`, `/` and emoji presentation", () => {
    for (const tag of ["rust", "dev_ops", "3d-printing", "area/sub", "日本語", "🧵"]) {
      expect(isTagBody(tag), tag).toBe(true);
    }
  });

  it("accepts a digits-only body: §3.7.3 is a recognition rule, not this one", () => {
    // The tokenizer refuses to read `#1984` in prose ("Suite #200"), while a
    // frontmatter `tags: [1984]` is a valid tag value (§3.7.3, §3.7.6). This
    // predicate answers the charset question only, so it accepts it.
    expect(isTagBody("1984")).toBe(true);
  });

  it("does not treat the `#` marker as part of the body", () => {
    // Callers holding `#tag` strip it first (`cleanTagToken`); `isTagBody` is
    // about the body alone, which is what the tokenizer slices.
    expect(isTagBody("#rust")).toBe(false);
    expect(isTagBody("rust")).toBe(true);
  });
});
