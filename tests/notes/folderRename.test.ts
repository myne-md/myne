// Folder rename (MYND-144 Task 9): rewrite the `folder:` of every note under
// the old prefix (subtree bulk move → updated: bump) + prefix-rewrite the
// matching deliberate_folders entries. Not correctness-critical for wikilink
// resolution (Q4) → notes are moved best-effort (partial-fail reported).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const moveNoteMock = vi.fn();
const setDeliberateFoldersMock = vi.fn();
vi.mock("../../src/notes/moveNote", () => ({
  moveNote: (...a: unknown[]) => moveNoteMock(...a),
}));
vi.mock("../../src/lib/prefs", () => ({
  setDeliberateFolders: (...a: unknown[]) => setDeliberateFoldersMock(...a),
}));

import { planFolderRename, renameFolder } from "../../src/notes/folderActions";

type Note = { noteUuid: string; folder: string | null };

beforeEach(() => {
  moveNoteMock.mockReset();
  setDeliberateFoldersMock.mockReset();
});
afterEach(() => {
  moveNoteMock.mockReset();
  setDeliberateFoldersMock.mockReset();
});

describe("planFolderRename — pure", () => {
  it("computes new folders for the renamed subtree, leaving others alone", () => {
    const notes: Note[] = [
      { noteUuid: "n1", folder: "Projects/" },
      { noteUuid: "n2", folder: "Projects/Myne/" },
      { noteUuid: "n3", folder: "Other/" },
      { noteUuid: "n4", folder: null },
    ];
    const plan = planFolderRename("Projects/", "Work/", notes, []);
    if ("invalid" in plan) throw new Error("unexpected invalid");
    expect(plan.moves).toEqual([
      { noteId: "n1", newFolder: "Work/" },
      { noteId: "n2", newFolder: "Work/Myne/" },
    ]);
  });

  it("prefix-rewrites matching deliberate_folders entries", () => {
    const plan = planFolderRename("Projects/", "Work/", [], [
      "Projects/",
      "Projects/Myne/",
      "Archive/",
    ]);
    if ("invalid" in plan) throw new Error("unexpected invalid");
    expect(plan.nextDeliberate).toEqual(["Work/", "Work/Myne/", "Archive/"]);
    expect(plan.deliberateRewritten).toBe(2);
  });

  it("does not prefix-false-match a name-prefix sibling", () => {
    const plan = planFolderRename("Projects/", "Work/", [
      { noteUuid: "x", folder: "Projectsx/" },
    ], ["Projectsx/"]);
    if ("invalid" in plan) throw new Error("unexpected invalid");
    expect(plan.moves).toEqual([]);
    expect(plan.nextDeliberate).toEqual(["Projectsx/"]);
  });

  it("matches case-insensitively, normalizing the renamed prefix", () => {
    const plan = planFolderRename("Projects/", "Work/", [
      { noteUuid: "n", folder: "projects/myne/" },
    ], []);
    if ("invalid" in plan) throw new Error("unexpected invalid");
    expect(plan.moves).toEqual([{ noteId: "n", newFolder: "Work/myne/" }]);
  });

  it("normalizes non-canonical inputs", () => {
    const plan = planFolderRename("Projects", "Work", [
      { noteUuid: "n", folder: "Projects/Sub" },
    ], []);
    if ("invalid" in plan) throw new Error("unexpected invalid");
    expect(plan.moves).toEqual([{ noteId: "n", newFolder: "Work/Sub/" }]);
  });

  it("is invalid for a root source/target", () => {
    expect(planFolderRename("", "Work/", [], [])).toEqual({ invalid: true });
    expect(planFolderRename("Projects/", "", [], [])).toEqual({ invalid: true });
  });

  it("is a no-op when source equals target", () => {
    const plan = planFolderRename("Projects/", "Projects/", [
      { noteUuid: "n", folder: "Projects/" },
    ], ["Projects/"]);
    if ("invalid" in plan) throw new Error("unexpected invalid");
    expect(plan.moves).toEqual([]);
    expect(plan.deliberateRewritten).toBe(0);
  });
});

describe("renameFolder — async apply (best-effort)", () => {
  it("moves each note + persists the rewritten deliberate set", async () => {
    moveNoteMock.mockResolvedValue(undefined);
    setDeliberateFoldersMock.mockResolvedValueOnce(undefined);
    const notes: Note[] = [
      { noteUuid: "n1", folder: "Projects/" },
      { noteUuid: "n2", folder: "Projects/Myne/" },
    ];
    const result = await renameFolder("Projects/", "Work/", notes, ["Projects/"]);
    expect(result.moved.sort()).toEqual(["n1", "n2"]);
    expect(result.failed).toEqual([]);
    expect(moveNoteMock).toHaveBeenCalledWith("n1", "Work/");
    expect(moveNoteMock).toHaveBeenCalledWith("n2", "Work/Myne/");
    expect(setDeliberateFoldersMock).toHaveBeenCalledWith(["Work/"]);
  });

  it("reports a per-note failure without aborting the rest", async () => {
    moveNoteMock.mockImplementation((id: string) =>
      id === "bad" ? Promise.reject({ kind: "Io" }) : Promise.resolve(undefined),
    );
    const notes: Note[] = [
      { noteUuid: "ok", folder: "P/" },
      { noteUuid: "bad", folder: "P/x/" },
    ];
    const result = await renameFolder("P/", "Q/", notes, []);
    expect(result.moved).toEqual(["ok"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.noteId).toBe("bad");
  });

  it("does not persist the deliberate set when nothing matched", async () => {
    moveNoteMock.mockResolvedValue(undefined);
    await renameFolder("P/", "Q/", [{ noteUuid: "n", folder: "P/" }], ["Other/"]);
    expect(setDeliberateFoldersMock).not.toHaveBeenCalled();
  });
});
