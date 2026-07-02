import { describe, expect, it } from "vitest";

import { isNoteAiExcluded } from "../../src/lib/aiExcludedFolders";

// AI excluded-folders filter (ai-ux-surface MYND-408, task 6, SYNC-14) — the
// predicate siblings 4/6/7 consume. Canonical trailing-slash folder paths.
describe("isNoteAiExcluded (AI excluded-folders filter)", () => {
  it("empty set excludes nothing", () => {
    expect(isNoteAiExcluded("Private/", [])).toBe(false);
    expect(isNoteAiExcluded("", [])).toBe(false);
  });

  it("excludes an exact folder match", () => {
    expect(isNoteAiExcluded("Private/", ["Private/"])).toBe(true);
  });

  it("excludes a note nested under an excluded folder", () => {
    expect(isNoteAiExcluded("Private/Notes/", ["Private/"])).toBe(true);
    expect(isNoteAiExcluded("Private/Notes/Deep/", ["Archive/", "Private/"])).toBe(true);
  });

  it("does NOT false-match a sibling whose name starts with the excluded name", () => {
    expect(isNoteAiExcluded("PrivateStuff/", ["Private/"])).toBe(false);
  });

  it("leaves an unrelated folder (and the vault root) in scope", () => {
    expect(isNoteAiExcluded("Work/", ["Private/"])).toBe(false);
    expect(isNoteAiExcluded("", ["Private/"])).toBe(false);
  });

  it("normalizes a missing trailing slash before the check", () => {
    expect(isNoteAiExcluded("Private", ["Private/"])).toBe(true);
  });
});
