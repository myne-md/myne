// Tests for folder-delete semantics (MYND-144 Task 8; non-empty delete added
// 2026-06-09). `planFolderDelete` collects the target subtree's notes (the
// caller soft-trashes them — recoverable, MYND-133) and cascade-removes the
// (note-empty) subtree from the deliberate_folders set. The pure plan never
// touches a note blob; `persistFolderDelete` writes only the trimmed set.
// Supersedes the pre-2026-06-09 "block when non-empty" behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setDeliberateFoldersMock = vi.fn();
vi.mock("../../src/lib/prefs", () => ({
  setDeliberateFolders: (...a: unknown[]) => setDeliberateFoldersMock(...a),
}));

import { deriveFolderTree } from "../../src/notes/folderTree";
import {
  planFolderDelete,
  persistFolderDelete,
} from "../../src/notes/folderActions";

beforeEach(() => setDeliberateFoldersMock.mockReset());
afterEach(() => setDeliberateFoldersMock.mockReset());

const tree = (
  notes: Array<{ noteUuid: string; folder: string | null }>,
  deliberate: string[] = [],
) => deriveFolderTree(notes, deliberate);

describe("planFolderDelete — collects the subtree's notes (no longer blocks)", () => {
  it("collects a direct note", () => {
    const t = tree([{ noteUuid: "n1", folder: "Projects/" }]);
    const plan = planFolderDelete("Projects/", t, []);
    expect(plan.noteIds).toEqual(["n1"]);
  });

  it("collects a descendant note", () => {
    const t = tree([{ noteUuid: "n1", folder: "Projects/Myne/" }]);
    const plan = planFolderDelete("Projects/", t, []);
    expect(plan.noteIds).toEqual(["n1"]);
  });

  it("collects every note across the whole subtree, not its siblings", () => {
    const t = tree([
      { noteUuid: "a", folder: "Projects/" },
      { noteUuid: "b", folder: "Projects/Myne/" },
      { noteUuid: "c", folder: "Other/" },
    ]);
    const plan = planFolderDelete("Projects/", t, []);
    expect(plan.noteIds.sort()).toEqual(["a", "b"]);
  });

  it("yields an empty noteIds for a note-empty folder", () => {
    const t = tree([], ["Drafts/"]);
    const plan = planFolderDelete("Drafts/", t, ["Drafts/"]);
    expect(plan.noteIds).toEqual([]);
  });

  it("still trims the deliberate set when the subtree holds notes", () => {
    const set = ["Busy/"];
    const t = tree([{ noteUuid: "n1", folder: "Busy/" }], set);
    const plan = planFolderDelete("Busy/", t, set);
    expect(plan.noteIds).toEqual(["n1"]);
    expect(plan.removed).toEqual(["Busy/"]);
    expect(plan.nextDeliberate).toEqual([]);
  });
});

describe("planFolderDelete — remove note-empty deliberate folders", () => {
  it("removes a single empty deliberate folder from the set", () => {
    const t = tree([], ["Drafts/"]);
    const plan = planFolderDelete("Drafts/", t, ["Drafts/"]);
    expect(plan.removed).toEqual(["Drafts/"]);
    expect(plan.nextDeliberate).toEqual([]);
  });

  it("cascade-removes a nested empty subtree in one action", () => {
    const set = ["Projects/", "Projects/Myne/", "Projects/Myne/Sub/"];
    const t = tree([], set);
    const plan = planFolderDelete("Projects/", t, set);
    expect(plan.removed.sort()).toEqual(
      ["Projects/", "Projects/Myne/", "Projects/Myne/Sub/"].sort(),
    );
    expect(plan.nextDeliberate).toEqual([]);
  });

  it("deleting a child keeps a deliberate parent", () => {
    const set = ["Projects/", "Projects/Myne/"];
    const t = tree([], set);
    const plan = planFolderDelete("Projects/Myne/", t, set);
    expect(plan.removed).toEqual(["Projects/Myne/"]);
    expect(plan.nextDeliberate).toEqual(["Projects/"]);
  });

  it("does not touch an unrelated sibling", () => {
    const set = ["Projects/", "Archive/"];
    const t = tree([], set);
    const plan = planFolderDelete("Projects/", t, set);
    expect(plan.nextDeliberate).toEqual(["Archive/"]);
  });

  it("does not prefix-false-match a sibling that shares a name prefix", () => {
    const set = ["Projects/", "Projectsx/"];
    const t = tree([], set);
    const plan = planFolderDelete("Projects/", t, set);
    expect(plan.nextDeliberate).toEqual(["Projectsx/"]);
  });

  it("matches case-insensitively (fold + NFC)", () => {
    const t = tree([], ["Projects/"]);
    const plan = planFolderDelete("projects/", t, ["Projects/"]);
    expect(plan.removed).toEqual(["Projects/"]);
  });
});

describe("persistFolderDelete — writes the trimmed deliberate set", () => {
  it("calls setDeliberateFolders with the next set", async () => {
    setDeliberateFoldersMock.mockResolvedValueOnce(undefined);
    const set = ["Drafts/", "Keep/"];
    const t = tree([], set);
    const plan = planFolderDelete("Drafts/", t, set);
    await persistFolderDelete(plan);
    expect(setDeliberateFoldersMock).toHaveBeenCalledTimes(1);
    expect(setDeliberateFoldersMock).toHaveBeenCalledWith(["Keep/"]);
  });
});
