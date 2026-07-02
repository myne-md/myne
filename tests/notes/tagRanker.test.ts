import { describe, expect, it } from "vitest";

import { rankTagCandidates } from "../../src/notes/ai/tagRanker";

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
});
