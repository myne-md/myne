// Conflict-copy materialization (MYND-424 task 7 / MYND-427): build a keep-both
// copy carrying `conflict: true` + `conflict_of: <uuid>`, and round-trip the
// read helpers the Conflicts view groups by.

import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  applyConflictVersion,
  buildConflictCopyContent,
  clearConflictMarkers,
  undoConflictVersion,
} from "../../src/notes/conflictCopy";
import {
  readConflictFromFmBody,
  readConflictOfFromFmBody,
} from "../../src/dialect";

// IPC-boundary mocks for the `applyConflictVersion` orchestration tests below.
// The pure functions (buildConflictCopyContent / clearConflictMarkers) and the
// real `migrateNoteUuidInPrefs` are NOT mocked — only the IPC siblings are.
const mocks = vi.hoisted(() => ({
  noteRead: vi.fn(),
  noteUpdate: vi.fn(),
  deleteNoteRouted: vi.fn(),
  prefsRead: vi.fn(),
  setFavorites: vi.fn(),
  setItemOrder: vi.fn(),
}));
vi.mock("../../src/notes/readNote", () => ({ noteRead: mocks.noteRead }));
vi.mock("../../src/notes/updateNote", () => ({ noteUpdate: mocks.noteUpdate }));
vi.mock("../../src/notes/deleteNote", () => ({
  deleteNoteRouted: mocks.deleteNoteRouted,
  deleteNote: mocks.deleteNoteRouted,
  noteDelete: mocks.deleteNoteRouted,
  tombstoneNote: vi.fn(),
}));
vi.mock("../../src/lib/prefs", () => ({
  prefsRead: mocks.prefsRead,
  setFavorites: mocks.setFavorites,
  setItemOrder: mocks.setItemOrder,
}));

const UUID = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";

/** Extract the FM body (between the --- fences) from full note content. */
function fmBody(content: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(content);
  return m ? (m[1] ?? "") : "";
}

describe("buildConflictCopyContent", () => {
  it("adds conflict:true + conflict_of on a body with no frontmatter", () => {
    const out = buildConflictCopyContent("# Remote edit\n", UUID);
    const body = fmBody(out);
    expect(readConflictFromFmBody(body)).toBe(true);
    expect(readConflictOfFromFmBody(body)).toBe(UUID);
    expect(out).toContain("# Remote edit");
  });

  it("composes onto an existing frontmatter without clobbering", () => {
    const remote = `---\ntitle: Notes\nfolder: Projects/\n---\n\nbody\n`;
    const out = buildConflictCopyContent(remote, UUID);
    const body = fmBody(out);
    expect(readConflictFromFmBody(body)).toBe(true);
    expect(readConflictOfFromFmBody(body)).toBe(UUID);
    expect(out).toContain("title: Notes");
    expect(out).toContain("folder: Projects/");
  });
});

describe("read helpers — value-strict", () => {
  it("conflict: is value-strict (only canonical true)", () => {
    expect(readConflictFromFmBody("conflict: true\n")).toBe(true);
    expect(readConflictFromFmBody("conflict: 1\n")).toBe(false);
    expect(readConflictFromFmBody('conflict: "true"\n')).toBe(false);
    expect(readConflictFromFmBody("title: x\n")).toBe(false);
  });

  it("conflict_of returns the uuid or null", () => {
    expect(readConflictOfFromFmBody(`conflict_of: ${UUID}\n`)).toBe(UUID);
    expect(readConflictOfFromFmBody("title: x\n")).toBeNull();
  });
});

describe("clearConflictMarkers", () => {
  it("removes both markers (keep-both-as-separate)", () => {
    const c = buildConflictCopyContent("body\n", UUID);
    const cleared = clearConflictMarkers(c);
    const body = fmBody(cleared);
    expect(readConflictFromFmBody(body)).toBe(false);
    expect(readConflictOfFromFmBody(body)).toBeNull();
  });
});

describe("applyConflictVersion (take theirs)", () => {
  const COPY = "22222222-2222-2222-2222-222222222222";
  const ORIG = "11111111-1111-1111-1111-111111111111";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.noteRead.mockResolvedValue(buildConflictCopyContent("remote body\n", ORIG));
    mocks.prefsRead.mockResolvedValue({ favorites: [], item_order: [] });
    mocks.noteUpdate.mockResolvedValue(undefined);
    mocks.deleteNoteRouted.mockResolvedValue(undefined);
    mocks.setFavorites.mockResolvedValue(undefined);
    mocks.setItemOrder.mockResolvedValue(undefined);
  });

  it("promotes the copy (clears its conflict markers) and tombstones the original", async () => {
    await applyConflictVersion(COPY, ORIG);
    expect(mocks.noteUpdate).toHaveBeenCalledTimes(1);
    const [id, content] = mocks.noteUpdate.mock.calls[0] as [string, string];
    expect(id).toBe(COPY);
    expect(content).not.toContain("conflict:");
    expect(content).toContain("remote body");
    expect(mocks.deleteNoteRouted).toHaveBeenCalledWith(ORIG);
  });

  it("migrates favorites + item_order membership from the original to the copy", async () => {
    mocks.prefsRead.mockResolvedValue({ favorites: [ORIG], item_order: [ORIG, "Folder/"] });
    await applyConflictVersion(COPY, ORIG);
    expect(mocks.setFavorites).toHaveBeenCalledWith([COPY]);
    expect(mocks.setItemOrder).toHaveBeenCalledWith([COPY, "Folder/"]);
  });

  it("skips the prefs write when the original is in neither favorites nor item_order", async () => {
    mocks.prefsRead.mockResolvedValue({ favorites: ["x"], item_order: ["y", "Folder/"] });
    await applyConflictVersion(COPY, ORIG);
    expect(mocks.setFavorites).not.toHaveBeenCalled();
    expect(mocks.setItemOrder).not.toHaveBeenCalled();
  });

  it("tombstones the original only AFTER the copy is promoted (no both-gone window)", async () => {
    const order: string[] = [];
    mocks.noteUpdate.mockImplementation(async () => {
      order.push("promote");
    });
    mocks.deleteNoteRouted.mockImplementation(async () => {
      order.push("tombstone");
    });
    await applyConflictVersion(COPY, ORIG);
    expect(order).toEqual(["promote", "tombstone"]);
  });
});

describe("undoConflictVersion (take-theirs undo)", () => {
  const COPY = "22222222-2222-2222-2222-222222222222";
  const ORIG = "11111111-1111-1111-1111-111111111111";

  beforeEach(() => {
    vi.clearAllMocks();
    // Original carries a `deleted:` tombstone (it was take-theirs'd); the copy is
    // an ordinary promoted note with markers cleared.
    mocks.noteRead.mockImplementation(async (id: string) =>
      id === ORIG
        ? "---\ndeleted: 2026-06-29T00:00:00Z\ntitle: Note\n---\n\nlocal body\n"
        : "remote body\n",
    );
    mocks.prefsRead.mockResolvedValue({ favorites: [], item_order: [] });
    mocks.noteUpdate.mockResolvedValue(undefined);
    mocks.setFavorites.mockResolvedValue(undefined);
    mocks.setItemOrder.mockResolvedValue(undefined);
  });

  it("un-tombstones the original (clears its deleted: marker)", async () => {
    await undoConflictVersion(COPY, ORIG);
    const origUpdate = mocks.noteUpdate.mock.calls.find((c) => c[0] === ORIG) as
      | [string, string]
      | undefined;
    expect(origUpdate).toBeDefined();
    expect(origUpdate![1]).not.toContain("deleted:");
    expect(origUpdate![1]).toContain("local body");
  });

  it("re-marks the copy as a conflict copy of the original", async () => {
    await undoConflictVersion(COPY, ORIG);
    const copyUpdate = mocks.noteUpdate.mock.calls.find((c) => c[0] === COPY) as
      | [string, string]
      | undefined;
    expect(copyUpdate).toBeDefined();
    expect(copyUpdate![1]).toContain("conflict_of");
    expect(copyUpdate![1]).toContain(ORIG);
    expect(copyUpdate![1]).toContain("remote body");
  });

  it("reverts the prefs migration (copy → original)", async () => {
    mocks.prefsRead.mockResolvedValue({ favorites: [COPY], item_order: [COPY, "Folder/"] });
    await undoConflictVersion(COPY, ORIG);
    expect(mocks.setFavorites).toHaveBeenCalledWith([ORIG]);
    expect(mocks.setItemOrder).toHaveBeenCalledWith([ORIG, "Folder/"]);
  });
});
