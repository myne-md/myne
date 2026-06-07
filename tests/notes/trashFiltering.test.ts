// Client-side exclusion of trashed notes from the live sidebar (MYND-133).
// Covers: TitleRecord.trashed population in loadNoteBatch; liveCache /
// trashedRecords partition; folder-tree exclusion + restore re-inclusion.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { loadNoteBatch, type TitleRecord } from "../../src/notes/loadNoteBatch";
import { liveCache, trashedRecords } from "../../src/notes/sidebarState";
import { deriveFolderTree } from "../../src/notes/folderTree";

beforeEach(() => invokeMock.mockReset());
afterEach(() => invokeMock.mockReset());

/** Build a note_titles_batch Ok-slice wire row. */
function okSlice(uuid: string, fmBody: string | null) {
  return { Ok: { note_uuid: uuid, frontmatter_bytes: fmBody, first_h1_line: null } };
}

function rec(
  uuid: string,
  folder: string | null,
  trashed: string | null,
): TitleRecord {
  return {
    noteUuid: uuid,
    title: null,
    folder,
    updatedAt: null,
    trashed,
    template: false,
  };
}

function cacheOf(records: TitleRecord[]): Map<string, TitleRecord> {
  return new Map(records.map((r) => [r.noteUuid, r]));
}

const TS = "2026-06-03T11:00:00Z";

describe("loadNoteBatch — trashed field population (value-strict)", () => {
  it("marks a note with a valid RFC 3339 trashed: as trashed", async () => {
    invokeMock.mockResolvedValueOnce([okSlice("a", `trashed: ${TS}\n`)]);
    const [r] = await loadNoteBatch(["a"]);
    expect(r?.trashed).toBe(TS);
  });

  it("leaves a note with a non-timestamp trashed: value live", async () => {
    invokeMock.mockResolvedValueOnce([okSlice("b", "trashed: true\n")]);
    const [r] = await loadNoteBatch(["b"]);
    expect(r?.trashed).toBeNull();
  });

  it("leaves a note with no trashed: field live", async () => {
    invokeMock.mockResolvedValueOnce([okSlice("c", "title: Foo\n")]);
    const [r] = await loadNoteBatch(["c"]);
    expect(r?.trashed).toBeNull();
  });

  it("error-fallback records are live (trashed null)", async () => {
    invokeMock.mockResolvedValueOnce([{ Err: { kind: "CannotDecrypt" } }]);
    const [r] = await loadNoteBatch(["d"]);
    expect(r?.trashed).toBeNull();
    expect(r?.error).toMatchObject({ kind: "CannotDecrypt" });
  });
});

describe("liveCache / trashedRecords partition", () => {
  it("splits the cache into live and trashed", () => {
    const cache = cacheOf([
      rec("live1", "Projects/", null),
      rec("trash1", "Projects/", TS),
      rec("live2", null, null),
    ]);
    expect([...liveCache(cache).keys()].sort()).toEqual(["live1", "live2"]);
    expect(trashedRecords(cache).map((r) => r.noteUuid)).toEqual(["trash1"]);
  });

  it("treats a record with a missing marker as live (defensive)", () => {
    const cache = new Map<string, TitleRecord>([
      // @ts-expect-error intentionally omit trashed to test the loose check
      ["x", { noteUuid: "x", title: null, folder: null, updatedAt: null }],
    ]);
    expect(liveCache(cache).has("x")).toBe(true);
    expect(trashedRecords(cache)).toEqual([]);
  });

  it("sorts trashed records newest-trashed first", () => {
    const cache = cacheOf([
      rec("old", null, "2026-01-01T00:00:00Z"),
      rec("new", null, "2026-06-01T00:00:00Z"),
    ]);
    expect(trashedRecords(cache).map((r) => r.noteUuid)).toEqual(["new", "old"]);
  });
});

describe("folder-tree exclusion + restore re-inclusion", () => {
  const records = (cache: Map<string, TitleRecord>) =>
    [...liveCache(cache).values()].map((r) => ({
      noteUuid: r.noteUuid,
      folder: r.folder,
    }));

  it("a folder holding only a trashed note disappears from the tree", () => {
    const trashed = cacheOf([rec("n1", "Solo/", TS)]);
    const tree = deriveFolderTree(records(trashed), []);
    expect(tree.roots.some((node) => node.path === "Solo/")).toBe(false);
  });

  it("the same folder resurrects once the note is restored (marker cleared)", () => {
    const restored = cacheOf([rec("n1", "Solo/", null)]);
    const tree = deriveFolderTree(records(restored), []);
    const solo = tree.roots.find((node) => node.path === "Solo/");
    expect(solo?.noteIds).toEqual(["n1"]);
  });

  it("a folder with a live sibling stays even when one note is trashed", () => {
    const mixed = cacheOf([
      rec("keep", "Shared/", null),
      rec("gone", "Shared/", TS),
    ]);
    const tree = deriveFolderTree(records(mixed), []);
    const shared = tree.roots.find((node) => node.path === "Shared/");
    expect(shared?.noteIds).toEqual(["keep"]);
  });
});
