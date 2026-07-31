import { describe, expect, it, vi } from "vitest";

import {
  buildTagPrompt,
  parseTagCandidates,
  runTagSuggestionPass,
} from "../../src/notes/ai/suggestTags";

// auto-tag-link (MYND-411) tasks 2 + 3 — on-demand pass + exclusion gate.
describe("parseTagCandidates", () => {
  it("parses a comma-separated list", () => {
    expect(parseTagCandidates("rust, crypto, ml")).toEqual([
      "rust",
      "crypto",
      "ml",
    ]);
  });

  it("parses a newline list and strips bullets and numbering", () => {
    expect(parseTagCandidates("- rust\n* crypto\n1. ml\n2) ai")).toEqual([
      "rust",
      "crypto",
      "ml",
      "ai",
    ]);
  });

  it("keeps a leading '#' (the ranker strips it) and drops empties", () => {
    expect(parseTagCandidates("#rust,\n\n , #ml")).toEqual(["#rust", "#ml"]);
  });

  it("does not eat a leading digit that is part of the tag", () => {
    // "3d-printing" must survive — the marker strip only fires on `N.`/`N)` +ws.
    expect(parseTagCandidates("3d-printing, 2fa")).toEqual(["3d-printing", "2fa"]);
  });
});

describe("buildTagPrompt", () => {
  it("includes the note body and, when present, an existing-vocabulary hint", () => {
    const p = buildTagPrompt("A note about rust and crypto.", ["rust"]);
    expect(p).toContain("rust and crypto");
    expect(p.toLowerCase()).toContain("existing tags");
  });

  it("omits the vocab hint when there are no existing tags", () => {
    const p = buildTagPrompt("body", []);
    expect(p.toLowerCase()).not.toContain("existing tags");
  });
});

describe("runTagSuggestionPass", () => {
  it("calls the tag model exactly once and ranks the parsed candidates (existing-vocab first)", async () => {
    const suggest = vi.fn().mockResolvedValue("newthing, work");
    const out = await runTagSuggestionPass({
      noteId: "note-1",
      noteBody: "some note",
      noteFolder: "Work/",
      existingTags: ["work"],
      excludedFolders: [],
      suggest,
    });
    expect(suggest).toHaveBeenCalledTimes(1);
    // The note id travels with the prompt: the host re-reads the note's own
    // folder from its blob rather than trusting a caller-supplied one (task 4).
    expect(suggest.mock.calls[0][0].noteId).toBe("note-1");
    expect(suggest.mock.calls[0][0].prompt).toContain("some note");
    expect(out.skipped).toBe(false);
    expect(out.deferred).toBe(false);
    expect(out.suggestions).toEqual([
      { tag: "work", isNew: false },
      { tag: "newthing", isNew: true },
    ]);
  });

  it("skips the pass and never calls the model for a note in an excluded folder", async () => {
    const suggest = vi.fn().mockResolvedValue("should-not-run");
    const out = await runTagSuggestionPass({
      noteId: "note-1",
      noteBody: "secret",
      noteFolder: "Private/Journal/",
      existingTags: [],
      excludedFolders: ["Private/"],
      suggest,
    });
    expect(suggest).not.toHaveBeenCalled();
    expect(out).toEqual({ suggestions: [], skipped: true, deferred: false });
  });

  it("proceeds normally for a note outside any excluded folder", async () => {
    const suggest = vi.fn().mockResolvedValue("rust");
    const out = await runTagSuggestionPass({
      noteId: "note-1",
      noteBody: "b",
      noteFolder: "Notes/",
      existingTags: [],
      excludedFolders: ["Private/"],
      suggest,
    });
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(out.suggestions).toEqual([{ tag: "rust", isNew: true }]);
  });

  it("reports a deferred host pass as deferred, not as an empty answer", async () => {
    // The host stood down so user-initiated work could have the compute lock
    // (task 4). Distinct from `Ok("")` — a caller must retry, never cache.
    const suggest = vi.fn().mockRejectedValue({ kind: "deferred" });
    const out = await runTagSuggestionPass({
      noteId: "note-1",
      noteBody: "b",
      noteFolder: "",
      existingTags: [],
      excludedFolders: [],
      suggest,
    });
    expect(out).toEqual({ suggestions: [], skipped: false, deferred: true });
  });

  it("treats an empty model reply as a real, cacheable empty answer", async () => {
    const suggest = vi.fn().mockResolvedValue("");
    const out = await runTagSuggestionPass({
      noteId: "note-1",
      noteBody: "b",
      noteFolder: "",
      existingTags: [],
      excludedFolders: [],
      suggest,
    });
    expect(out).toEqual({ suggestions: [], skipped: false, deferred: false });
  });

  it("propagates a genuine engine failure to the caller", async () => {
    const suggest = vi.fn().mockRejectedValue({ kind: "failed" });
    await expect(
      runTagSuggestionPass({
        noteId: "note-1",
        noteBody: "b",
        noteFolder: "",
        existingTags: [],
        excludedFolders: [],
        suggest,
      }),
    ).rejects.toEqual({ kind: "failed" });
  });
});
