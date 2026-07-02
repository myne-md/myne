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
  it("calls infer exactly once and ranks the parsed candidates (existing-vocab first)", async () => {
    const infer = vi.fn().mockResolvedValue("newthing, work");
    const out = await runTagSuggestionPass({
      noteBody: "some note",
      noteFolder: "Work/",
      existingTags: ["work"],
      excludedFolders: [],
      infer,
    });
    expect(infer).toHaveBeenCalledTimes(1);
    expect(out.skipped).toBe(false);
    expect(out.suggestions).toEqual([
      { tag: "work", isNew: false },
      { tag: "newthing", isNew: true },
    ]);
  });

  it("skips the pass and never calls infer for a note in an excluded folder", async () => {
    const infer = vi.fn().mockResolvedValue("should-not-run");
    const out = await runTagSuggestionPass({
      noteBody: "secret",
      noteFolder: "Private/Journal/",
      existingTags: [],
      excludedFolders: ["Private/"],
      infer,
    });
    expect(infer).not.toHaveBeenCalled();
    expect(out).toEqual({ suggestions: [], skipped: true });
  });

  it("proceeds normally for a note outside any excluded folder", async () => {
    const infer = vi.fn().mockResolvedValue("rust");
    const out = await runTagSuggestionPass({
      noteBody: "b",
      noteFolder: "Notes/",
      existingTags: [],
      excludedFolders: ["Private/"],
      infer,
    });
    expect(infer).toHaveBeenCalledTimes(1);
    expect(out.suggestions).toEqual([{ tag: "rust", isNew: true }]);
  });
});
