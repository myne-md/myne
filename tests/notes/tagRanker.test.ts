import { describe, expect, it } from "vitest";

import { cleanTagToken, rankTagCandidates } from "../../src/notes/ai/tagRanker";

// auto-tag-link (MYND-411) task 1 — the pure ranker + folded-vocabulary bias.
describe("rankTagCandidates", () => {
  it("ranks existing-vocabulary tags ahead of new tags", () => {
    const out = rankTagCandidates(["work", "ml"], ["newidea", "work"]);
    expect(out).toEqual([
      { tag: "work", isNew: false },
      { tag: "newidea", isNew: true },
    ]);
  });

  it("collapses a new candidate that folds onto an existing tag (canonical casing kept)", () => {
    // Candidate normalizes onto the existing folded tag → no near-dup as new.
    const out = rankTagCandidates(["Machine-Learning"], ["machine-learning"]);
    expect(out).toEqual([{ tag: "Machine-Learning", isNew: false }]);
  });

  it("flags genuinely-new tags as isNew: true", () => {
    const out = rankTagCandidates(["work"], ["rust", "crypto"]);
    expect(out).toEqual([
      { tag: "rust", isNew: true },
      { tag: "crypto", isNew: true },
    ]);
  });

  it("is deterministic across repeated calls with the same inputs", () => {
    const existing = ["alpha", "beta"];
    const cands = ["gamma", "Alpha", "beta", "delta"];
    const first = rankTagCandidates(existing, cands);
    const second = rankTagCandidates(existing, cands);
    expect(first).toEqual(second);
    // alpha + beta are existing (rank first, input order among existing:
    // "Alpha" then "beta"); gamma + delta are new (input order).
    expect(first).toEqual([
      { tag: "alpha", isNew: false },
      { tag: "beta", isNew: false },
      { tag: "gamma", isNew: true },
      { tag: "delta", isNew: true },
    ]);
  });

  it("strips a leading '#' so a hashtag candidate collapses onto a bare existing tag", () => {
    const out = rankTagCandidates(["ml"], ["#ml"]);
    expect(out).toEqual([{ tag: "ml", isNew: false }]);
  });

  it("collapses two new candidates that fold together into one suggestion", () => {
    const out = rankTagCandidates([], ["ai", "AI", "Ai"]);
    expect(out).toEqual([{ tag: "ai", isNew: true }]);
  });

  it("skips empty / whitespace / bare-hash candidates", () => {
    const out = rankTagCandidates([], ["", "   ", "#", "real"]);
    expect(out).toEqual([{ tag: "real", isNew: true }]);
  });

  it("dedupes existing-vocabulary hits that repeat in the candidate list", () => {
    const out = rankTagCandidates(["work"], ["work", "Work", "WORK"]);
    expect(out).toEqual([{ tag: "work", isNew: false }]);
  });

  it("returns an empty list when there are no candidates", () => {
    expect(rankTagCandidates(["work"], [])).toEqual([]);
  });

  it("cleans JSON-array residue left by the comma split into plain tags (#192)", () => {
    // `["python", "web"]` reaches the ranker as two pieces, each carrying one
    // half of the array's punctuation.
    const out = rankTagCandidates([], ['["python"', ' "web"]']);
    expect(out).toEqual([
      { tag: "python", isNew: true },
      { tag: "web", isNew: true },
    ]);
  });

  it("folds a bracketed candidate onto the existing tag instead of suggesting a twin (#192)", () => {
    // The whole point of stripping in cleanTagToken rather than at display: a
    // bracketed token used to miss the fold and offer a duplicate as new.
    const out = rankTagCandidates(["python"], ["[Python]"]);
    expect(out).toEqual([{ tag: "python", isNew: false }]);
  });

  it("folds a quoted hashtag exactly like a bare one (#192)", () => {
    const out = rankTagCandidates(["ml"], ['"#ml"']);
    expect(out).toEqual([{ tag: "ml", isNew: false }]);
  });

  it("drops candidates that are nothing but punctuation (#192)", () => {
    const out = rankTagCandidates([], ["[]", '"', "[ ]", "''", "real"]);
    expect(out).toEqual([{ tag: "real", isNew: true }]);
  });

  // myne-md/myne#1025: the pass offered whatever the model emitted. A one-line
  // reply of `(#Writing with Markdown, Tasks, Links and tags, Make it yours,
  // Trash)` became five chips, and two of them carried a parenthesis: the comma
  // split leaves the wrapping parens on the outermost pieces, and a strip list
  // of `[]`/quotes cannot see them. Accepting one wrote a tag no inline `#tag`
  // can ever match.
  describe("legality gate (§3.7.2)", () => {
    it("drops the pieces of a parenthesised model list, keeping the legal one", () => {
      const out = rankTagCandidates([], [
        "(#Writing with Markdown",
        "Tasks",
        "Links and tags",
        "Make it yours",
        "Trash)",
      ]);
      expect(out).toEqual([{ tag: "Tasks", isNew: true }]);
    });

    it("does not salvage a paren by trimming it, the candidate goes", () => {
      // The tempting one-line fix (strip `(`/`)` in cleanTagToken) leaves
      // `#Writing with Markdown`, which is still not a tag body. A candidate is
      // either legal or it is not offered at all.
      expect(rankTagCandidates([], ["(rust)", "(", ")"])).toEqual([]);
    });

    it("drops every whitespace form, hyphenated forms survive", () => {
      expect(rankTagCandidates([], ["machine learning", "links and tags"])).toEqual([]);
      expect(rankTagCandidates([], ["machine-learning"])).toEqual([
        { tag: "machine-learning", isNew: true },
      ]);
    });

    it("drops developer spellings the inline grammar denies (accepted cost)", () => {
      // `c++`, `c#` and `node.js` are real frontmatter tags a user may keep, but
      // the parser cannot express any of them (`+`, `#`, `.` are denied), so a
      // chip for one would write a tag the user can never type again.
      expect(rankTagCandidates([], ["c++", "c#", "node.js", "don't"])).toEqual([]);
    });

    it("keeps nested, non-ASCII, emoji and numeric-only bodies", () => {
      // §3.7.3's numeric-only reject is a RECOGNITION rule, not a legality one
      // (frontmatter has always accepted `1984`), so it is deliberately absent.
      expect(
        rankTagCandidates([], ["area/sub", "日本語", "🧵", "1984", "dev_ops"]),
      ).toEqual([
        { tag: "area/sub", isNew: true },
        { tag: "日本語", isNew: true },
        { tag: "🧵", isNew: true },
        { tag: "1984", isNew: true },
        { tag: "dev_ops", isNew: true },
      ]);
    });

    it("never proposes a junk tag the vault already carries", () => {
      // The existing-vocabulary side stays permissive on purpose (§3.7.6): a
      // user's file keeps what it has. A candidate that folds onto such an entry
      // is dropped by the gate above rather than shown as an accepted-looking
      // chip, so no input reaches the vocabulary loop with junk, and no test can
      // prove that loop is ungated (an injection there keeps every test green).
      // What IS observable is that the loop still collapses onto an existing
      // tag's canonical casing.
      expect(rankTagCandidates(["(#x"], ["(#x"])).toEqual([]);
      expect(rankTagCandidates(["Machine-Learning"], ["machine-learning"])).toEqual([
        { tag: "Machine-Learning", isNew: false },
      ]);
    });
  });
});

// #192 — the single place both the chip's display text and the fold key come
// from, so every strip below is load-bearing twice.
describe("cleanTagToken", () => {
  it("strips square brackets wherever they appear", () => {
    expect(cleanTagToken("[python]")).toBe("python");
    expect(cleanTagToken('["python')).toBe("python");
    expect(cleanTagToken('web"]')).toBe("web");
  });

  it("strips edge quotes without requiring a matching pair", () => {
    expect(cleanTagToken('"python"')).toBe("python");
    expect(cleanTagToken('web"')).toBe("web");
    expect(cleanTagToken("'rust'")).toBe("rust");
    expect(cleanTagToken("“ml”")).toBe("ml");
  });

  it("keeps an internal apostrophe", () => {
    expect(cleanTagToken("don't")).toBe("don't");
    expect(cleanTagToken("'don't'")).toBe("don't");
  });

  it("strips quotes before the '#' so a quoted hashtag reduces like a bare one", () => {
    expect(cleanTagToken('"#ml"')).toBe("ml");
    expect(cleanTagToken("#ml")).toBe("ml");
  });

  it("reduces a punctuation-only token to the empty string", () => {
    expect(cleanTagToken("[]")).toBe("");
    expect(cleanTagToken('"')).toBe("");
    expect(cleanTagToken("[ ]")).toBe("");
  });

  it("leaves an ordinary tag untouched", () => {
    expect(cleanTagToken("machine-learning")).toBe("machine-learning");
    expect(cleanTagToken("  3d-printing  ")).toBe("3d-printing");
  });
});
