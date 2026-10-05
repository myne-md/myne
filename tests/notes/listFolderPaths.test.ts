// Unit tests for `src/notes/listFolderPaths.ts` — the folder enumeration the
// periodic-notes picker, the new-note-location picker and the command palette
// all read.
//
// The regression under test: a deliberately-created EMPTY folder (the
// `deliberate_folders` prefs set, MYND-144) is a real folder the sidebar shows,
// but the pickers enumerate folders from notes alone and so never offer it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const noteList = vi.fn();
const loadNoteBatch = vi.fn();
const prefsRead = vi.fn();

vi.mock("../../src/notes/listNotes", () => ({
  noteList: (...a: unknown[]) => noteList(...a),
}));
vi.mock("../../src/notes/loadNoteBatch", () => ({
  loadNoteBatch: (...a: unknown[]) => loadNoteBatch(...a),
}));
vi.mock("../../src/lib/prefs", () => ({
  prefsRead: (...a: unknown[]) => prefsRead(...a),
}));

import { listFolderPaths } from "../../src/notes/listFolderPaths";

function rec(noteUuid: string, folder: string | null) {
  return { noteUuid, folder };
}

beforeEach(() => {
  noteList.mockReset();
  loadNoteBatch.mockReset();
  prefsRead.mockReset();
  prefsRead.mockResolvedValue({
    deliberate_folders: [],
    archived_folders: [],
  });
});

describe("listFolderPaths — deliberate empty folders", () => {
  it("offers a deliberate folder that holds no notes", async () => {
    noteList.mockResolvedValue(["n1"]);
    loadNoteBatch.mockResolvedValue([rec("n1", null)]);
    prefsRead.mockResolvedValue({
      deliberate_folders: ["Empty/"],
      archived_folders: [],
    });

    const out = await listFolderPaths();
    expect(out.map((o) => o.path)).toContain("Empty/");
  });

  it("offers a deliberate folder even when the vault has no notes", async () => {
    noteList.mockResolvedValue([]);
    loadNoteBatch.mockResolvedValue([]);
    prefsRead.mockResolvedValue({
      deliberate_folders: ["Empty/"],
      archived_folders: [],
    });

    const out = await listFolderPaths();
    expect(out.map((o) => o.path)).toContain("Empty/");
  });

  it("synthesises ancestors of a nested deliberate folder", async () => {
    noteList.mockResolvedValue([]);
    loadNoteBatch.mockResolvedValue([]);
    prefsRead.mockResolvedValue({
      deliberate_folders: ["Projects/Myne/"],
      archived_folders: [],
    });

    const out = (await listFolderPaths()).map((o) => o.path);
    expect(out).toContain("Projects/");
    expect(out).toContain("Projects/Myne/");
  });

  it("hides a deliberate folder that sits under an archived folder", async () => {
    noteList.mockResolvedValue([]);
    loadNoteBatch.mockResolvedValue([]);
    prefsRead.mockResolvedValue({
      deliberate_folders: ["Projects/"],
      archived_folders: ["Projects/"],
    });

    const out = (await listFolderPaths()).map((o) => o.path);
    expect(out).not.toContain("Projects/");
  });

  it("still returns [] when there are no notes and no deliberate folders", async () => {
    noteList.mockResolvedValue([]);
    loadNoteBatch.mockResolvedValue([]);

    const out = await listFolderPaths();
    expect(out).toEqual([]);
  });
});

describe("listFolderPaths — note-derived folders", () => {
  it("offers folders found on notes, labelled by depth", async () => {
    noteList.mockResolvedValue(["n1"]);
    loadNoteBatch.mockResolvedValue([rec("n1", "a/b/")]);

    const out = await listFolderPaths();
    expect(out.map((o) => o.path).sort()).toEqual(["a/", "a/b/"]);
  });
});
