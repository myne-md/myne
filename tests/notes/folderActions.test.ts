// Tests for folder-delete semantics (MYND-144 Task 8): block a folder whose
// subtree holds any note; otherwise cascade-remove the (note-empty) subtree
// from the deliberate_folders set. Folder-delete NEVER touches a note blob.
// Grill 2026-05-29 Q8 (non-empty-delete = block; v0.1 has no trash).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setDeliberateFoldersMock = vi.fn();
vi.mock("../../src/lib/prefs", () => ({
  setDeliberateFolders: (...a: unknown[]) => setDeliberateFoldersMock(...a),
}));

import { deriveFolderTree } from "../../src/notes/folderTree";
import { planFolderDelete, deleteFolder } from "../../src/notes/folderActions";

beforeEach(() => setDeliberateFoldersMock.mockReset());
afterEach(() => setDeliberateFoldersMock.mockReset());

const tree = (
  notes: Array<{ noteUuid: string; folder: string | null }>,
  deliberate: string[] = [],
) => deriveFolderTree(notes, deliberate);

describe("planFolderDelete — block when subtree holds a note", () => {
  it("blocks a folder with a direct note", () => {
    const t = tree([{ noteUuid: "n1", folder: "Projects/" }]);
    const plan = planFolderDelete("Projects/", t, []);
    expect(plan).toMatchObject({ blocked: true, reason: "non-empty", noteCount: 1 });
  });

  it("blocks a folder whose descendant holds a note", () => {
    const t = tree([{ noteUuid: "n1", folder: "Projects/Myne/" }]);
    const plan = planFolderDelete("Projects/", t, []);
    expect(plan).toMatchObject({ blocked: true, noteCount: 1 });
  });
});

describe("planFolderDelete — remove note-empty deliberate folders", () => {
  it("removes a single empty deliberate folder from the set", () => {
    const t = tree([], ["Drafts/"]);
    const plan = planFolderDelete("Drafts/", t, ["Drafts/"]);
    expect(plan).toMatchObject({ blocked: false, removed: ["Drafts/"], nextDeliberate: [] });
  });

  it("cascade-removes a nested empty subtree in one action", () => {
    const set = ["Projects/", "Projects/Myne/", "Projects/Myne/Sub/"];
    const t = tree([], set);
    const plan = planFolderDelete("Projects/", t, set);
    if (plan.blocked) throw new Error("should not block");
    expect(plan.removed.sort()).toEqual(
      ["Projects/", "Projects/Myne/", "Projects/Myne/Sub/"].sort(),
    );
    expect(plan.nextDeliberate).toEqual([]);
  });

  it("deleting a child keeps a deliberate parent", () => {
    const set = ["Projects/", "Projects/Myne/"];
    const t = tree([], set);
    const plan = planFolderDelete("Projects/Myne/", t, set);
    if (plan.blocked) throw new Error("should not block");
    expect(plan.removed).toEqual(["Projects/Myne/"]);
    expect(plan.nextDeliberate).toEqual(["Projects/"]);
  });

  it("does not touch an unrelated sibling", () => {
    const set = ["Projects/", "Archive/"];
    const t = tree([], set);
    const plan = planFolderDelete("Projects/", t, set);
    if (plan.blocked) throw new Error("should not block");
    expect(plan.nextDeliberate).toEqual(["Archive/"]);
  });

  it("does not prefix-false-match a sibling that shares a name prefix", () => {
    const set = ["Projects/", "Projectsx/"];
    const t = tree([], set);
    const plan = planFolderDelete("Projects/", t, set);
    if (plan.blocked) throw new Error("should not block");
    expect(plan.nextDeliberate).toEqual(["Projectsx/"]);
  });

  it("matches case-insensitively (fold + NFC)", () => {
    const t = tree([], ["Projects/"]);
    const plan = planFolderDelete("projects/", t, ["Projects/"]);
    if (plan.blocked) throw new Error("should not block");
    expect(plan.removed).toEqual(["Projects/"]);
  });
});

describe("deleteFolder — persists only when not blocked", () => {
  it("calls setDeliberateFolders with the next set when not blocked", async () => {
    setDeliberateFoldersMock.mockResolvedValueOnce(undefined);
    const set = ["Drafts/", "Keep/"];
    const t = tree([], set);
    const plan = await deleteFolder("Drafts/", t, set);
    expect(plan.blocked).toBe(false);
    expect(setDeliberateFoldersMock).toHaveBeenCalledTimes(1);
    expect(setDeliberateFoldersMock).toHaveBeenCalledWith(["Keep/"]);
  });

  it("does NOT persist (or touch any note) when blocked", async () => {
    const t = tree([{ noteUuid: "n1", folder: "Busy/" }], ["Busy/"]);
    const plan = await deleteFolder("Busy/", t, ["Busy/"]);
    expect(plan.blocked).toBe(true);
    expect(setDeliberateFoldersMock).not.toHaveBeenCalled();
  });
});
