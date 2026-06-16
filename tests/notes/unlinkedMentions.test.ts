// Unlinked-mentions matcher + false-positive floor (MYND-196, build-phase v1.1).
// Word-boundary fold identity + corpus-frequency floor + ≤2-char guard.

import { describe, expect, it } from "vitest";

import {
  foldedTitleMatches,
  mentionCandidateSignature,
  passesMentionFloor,
} from "../../src/notes/unlinkedMentions";
import type { NoteSearchResult } from "../../src/types/note-search-result";

const hit = (note_id: string): NoteSearchResult => ({
  note_id,
  title: note_id,
  score: 1,
  matched_in: { title: false, body: true },
});

describe("foldedTitleMatches", () => {
  it("matches a whole-word title (fold-insensitive)", () => {
    expect(foldedTitleMatches("I read Project Apollo today", "Project Apollo")).toBe(
      true,
    );
  });

  it("does NOT match a substring — word boundary ('Index' ⊄ 'reindex')", () => {
    expect(foldedTitleMatches("a reindex pass", "Index")).toBe(false);
  });

  it("matches a multi-word title only as a CONTIGUOUS phrase", () => {
    expect(foldedTitleMatches("Project then Apollo", "Project Apollo")).toBe(false);
    expect(foldedTitleMatches("the Project Apollo mission", "Project Apollo")).toBe(
      true,
    );
  });

  it("is case-insensitive (ASCII fold)", () => {
    expect(foldedTitleMatches("see ISTANBUL notes", "istanbul")).toBe(true);
  });

  it("returns false for an empty title", () => {
    expect(foldedTitleMatches("anything here", "")).toBe(false);
  });
});

describe("passesMentionFloor", () => {
  it("suppresses ≤2 folded-char titles", () => {
    expect(passesMentionFloor("Hi", 1, 100)).toBe(false);
  });

  it("suppresses high-df common-word titles (df > ceiling)", () => {
    expect(passesMentionFloor("Note", 30, 100)).toBe(false); // 0.30 > 0.15
  });

  it("shows low-df titles ≥ 3 folded chars", () => {
    expect(passesMentionFloor("Apollo", 3, 100)).toBe(true); // 0.03 ≤ 0.15
  });

  it("shows when there is no corpus to suppress against", () => {
    expect(passesMentionFloor("Apollo", 0, 0)).toBe(true);
  });

  it("skips the df clause below the minimum corpus (small/new vaults aren't blinded)", () => {
    // 3-note vault: every mentioned title has df ≥ 1/3 = 0.33 > the 0.15 ceiling.
    // The df filter is a large-vault common-word suppressor; below the min corpus
    // it must NOT fire, or a new vault never surfaces a single unlinked mention.
    expect(passesMentionFloor("Project Apollo", 3, 3)).toBe(true);
    expect(passesMentionFloor("Project Apollo", 2, 10)).toBe(true); // 0.20, but N<20
  });

  it("still suppresses a genuinely common word once the corpus is large enough", () => {
    expect(passesMentionFloor("Note", 6, 20)).toBe(false); // N≥20, 0.30 > 0.15
  });

  it("passes exactly AT the df ceiling (boundary is strictly greater-than)", () => {
    // df = 3/20 = 0.15 — equal to the ceiling, NOT greater, so it passes.
    expect(passesMentionFloor("Apollo", 3, 20)).toBe(true);
    // df = 4/20 = 0.20 > 0.15 — suppressed.
    expect(passesMentionFloor("Apollo", 4, 20)).toBe(false);
  });
});

describe("mentionCandidateSignature (SYNC-14 candidate-change key)", () => {
  it("is order-independent (recall order can't flip the signal)", () => {
    expect(mentionCandidateSignature([hit("b"), hit("a"), hit("c")])).toBe(
      mentionCandidateSignature([hit("a"), hit("c"), hit("b")]),
    );
  });

  it("joins sorted note ids with commas", () => {
    expect(mentionCandidateSignature([hit("z"), hit("a")])).toBe("a,z");
  });

  it("is empty for an empty candidate set", () => {
    expect(mentionCandidateSignature([])).toBe("");
  });

  it("changes when the candidate set changes", () => {
    expect(mentionCandidateSignature([hit("a")])).not.toBe(
      mentionCandidateSignature([hit("a"), hit("b")]),
    );
  });
});
