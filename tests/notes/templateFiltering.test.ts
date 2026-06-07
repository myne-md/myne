// Client-side inverse-visibility of templates in the sidebar (MYND-186).
// Covers: TitleRecord.template population in loadNoteBatch; liveCache excludes
// templates; templateRecords enumeration (trashed templates excluded);
// trashedCount independent of the template flag; folder-tree exclusion +
// convert-back re-inclusion; the template+trashed composition.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { loadNoteBatch, type TitleRecord } from "../../src/notes/loadNoteBatch";
import {
  liveCache,
  trashedRecords,
  trashedCount,
  templateRecords,
} from "../../src/notes/sidebarState";
import { deriveFolderTree } from "../../src/notes/folderTree";

beforeEach(() => invokeMock.mockReset());
afterEach(() => invokeMock.mockReset());

/** Build a note_titles_batch Ok-slice wire row. */
function okSlice(uuid: string, fmBody: string | null) {
  return {
    Ok: { note_uuid: uuid, frontmatter_bytes: fmBody, first_h1_line: null },
  };
}

function rec(
  uuid: string,
  folder: string | null,
  trashed: string | null,
  template: boolean,
): TitleRecord {
  return { noteUuid: uuid, title: uuid, folder, updatedAt: null, trashed, template };
}

function cacheOf(records: TitleRecord[]): Map<string, TitleRecord> {
  return new Map(records.map((r) => [r.noteUuid, r]));
}

const TS = "2026-06-03T11:00:00Z";

describe("loadNoteBatch — template field population (value-strict)", () => {
  it("marks a note with canonical template: true as a template", async () => {
    invokeMock.mockResolvedValueOnce([okSlice("a", "template: true\n")]);
    const [r] = await loadNoteBatch(["a"]);
    expect(r?.template).toBe(true);
  });

  it("leaves a note with template: 1 (non-canonical) an ordinary note", async () => {
    invokeMock.mockResolvedValueOnce([okSlice("b", "template: 1\n")]);
    const [r] = await loadNoteBatch(["b"]);
    expect(r?.template).toBe(false);
  });

  it("leaves a note with no template: field ordinary", async () => {
    invokeMock.mockResolvedValueOnce([okSlice("c", "title: Foo\n")]);
    const [r] = await loadNoteBatch(["c"]);
    expect(r?.template).toBe(false);
  });

  it("error-fallback records are ordinary (template false)", async () => {
    invokeMock.mockResolvedValueOnce([{ Err: { kind: "CannotDecrypt" } }]);
    const [r] = await loadNoteBatch(["d"]);
    expect(r?.template).toBe(false);
  });
});

describe("liveCache / templateRecords partition", () => {
  it("excludes templates from the live working set", () => {
    const cache = cacheOf([
      rec("note1", "Projects/", null, false),
      rec("tmpl1", null, null, true),
      rec("note2", null, null, false),
    ]);
    expect([...liveCache(cache).keys()].sort()).toEqual(["note1", "note2"]);
  });

  it("templateRecords returns exactly the (non-trashed) template set", () => {
    const cache = cacheOf([
      rec("note1", null, null, false),
      rec("tmpl1", null, null, true),
      rec("tmpl2", null, null, true),
    ]);
    expect(templateRecords(cache).map((r) => r.noteUuid).sort()).toEqual([
      "tmpl1",
      "tmpl2",
    ]);
  });

  it("a trashed template is absent from live, templates, and present in trash", () => {
    const cache = cacheOf([rec("both", null, TS, true)]);
    expect(liveCache(cache).has("both")).toBe(false);
    expect(templateRecords(cache)).toEqual([]);
    expect(trashedRecords(cache).map((r) => r.noteUuid)).toEqual(["both"]);
  });

  it("trashedCount counts trashed notes incl. trashed templates, ignoring live templates", () => {
    const cache = cacheOf([
      rec("liveNote", null, null, false),
      rec("liveTmpl", null, null, true),
      rec("trashNote", null, TS, false),
      rec("trashTmpl", null, TS, true),
    ]);
    // 2 trashed (one ordinary, one template); the live template must NOT count.
    expect(trashedCount(cache)).toBe(2);
  });
});

describe("folder-tree exclusion + convert-back re-inclusion", () => {
  const records = (cache: Map<string, TitleRecord>) =>
    [...liveCache(cache).values()].map((r) => ({
      noteUuid: r.noteUuid,
      folder: r.folder,
    }));

  it("a folder holding only a template disappears from the tree", () => {
    const tmpl = cacheOf([rec("t1", "Solo/", null, true)]);
    const tree = deriveFolderTree(records(tmpl), []);
    expect(tree.roots.some((node) => node.path === "Solo/")).toBe(false);
  });

  it("the same folder resurrects once the template is converted back to a note", () => {
    const converted = cacheOf([rec("t1", "Solo/", null, false)]);
    const tree = deriveFolderTree(records(converted), []);
    const solo = tree.roots.find((node) => node.path === "Solo/");
    expect(solo?.noteIds).toEqual(["t1"]);
  });

  it("a folder with a live sibling stays even when one note becomes a template", () => {
    const mixed = cacheOf([
      rec("keep", "Shared/", null, false),
      rec("tmpl", "Shared/", null, true),
    ]);
    const tree = deriveFolderTree(records(mixed), []);
    const shared = tree.roots.find((node) => node.path === "Shared/");
    expect(shared?.noteIds).toEqual(["keep"]);
  });
});
