// Obsidian importer ports — the IO-bound helpers (MYND-53) that the existing
// `import-ports.test.ts` deliberately leaves out: `buildMediaIndex` (recursive
// walk + dot-skip + first-match-wins), `createImportPorts.setDeliberateFolders`
// (prefs union + read-failure fallback), `createMediaRefImporter` (candidate
// fall-through), and `loadExistingIdentity`. All Tauri/IPC seams are mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock every IO seam ports.ts pulls in. ---
const prefsRead = vi.fn();
const setDeliberateFolders = vi.fn();
const noteCreate = vi.fn();
const noteList = vi.fn();
const loadNoteBatch = vi.fn();
const attachmentImport = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../src/lib/prefs", () => ({
  prefsRead: (...a: unknown[]) => prefsRead(...a),
  setDeliberateFolders: (...a: unknown[]) => setDeliberateFolders(...a),
}));
vi.mock("../../src/notes/createNote", () => ({
  noteCreate: (...a: unknown[]) => noteCreate(...a),
}));
vi.mock("../../src/notes/listNotes", () => ({
  noteList: (...a: unknown[]) => noteList(...a),
}));
vi.mock("../../src/notes/loadNoteBatch", () => ({
  loadNoteBatch: (...a: unknown[]) => loadNoteBatch(...a),
}));
vi.mock("../../src/lib/attachments", () => ({
  attachmentImport: (...a: unknown[]) => attachmentImport(...a),
}));

import {
  buildMediaIndex,
  createImportPorts,
  createMediaRefImporter,
  loadExistingIdentity,
} from "../../src/notes/import/ports";
import {
  noteIdentityKey,
} from "../../src/notes/import/conflict";
import type { ImportDirEntry, ImportPorts } from "../../src/notes/import/engine";

beforeEach(() => {
  for (const m of [
    prefsRead,
    setDeliberateFolders,
    noteCreate,
    noteList,
    loadNoteBatch,
    attachmentImport,
  ]) {
    m.mockReset();
  }
});

afterEach(() => vi.clearAllMocks());

/** A fake ports backed by an in-memory tree: `dir → entries`. */
function fakePorts(tree: Record<string, ImportDirEntry[]>): ImportPorts {
  return {
    readDir: async (absPath) => {
      const entries = tree[absPath];
      if (entries === undefined) throw new Error(`no such dir ${absPath}`);
      return entries;
    },
    readFile: async () => "",
    createNote: async () => "id",
    setDeliberateFolders: async () => {},
  };
}

const file = (name: string): ImportDirEntry => ({ name, isDir: false });
const dir = (name: string): ImportDirEntry => ({ name, isDir: true });

describe("buildMediaIndex", () => {
  it("recurses into subdirs and indexes files by lowercased basename", async () => {
    const ports = fakePorts({
      "/v": [dir("assets"), file("Top.PNG")],
      "/v/assets": [file("Inner.jpg")],
    });
    const idx = await buildMediaIndex("/v", ports);
    expect(idx.get("top.png")).toBe("/v/Top.PNG");
    expect(idx.get("inner.jpg")).toBe("/v/assets/Inner.jpg");
  });

  it("skips dot-entries (the .obsidian/ assets never resolve)", async () => {
    const ports = fakePorts({
      "/v": [dir(".obsidian"), file("real.png")],
      "/v/.obsidian": [file("theme.png")],
    });
    const idx = await buildMediaIndex("/v", ports);
    expect(idx.has("theme.png")).toBe(false);
    expect(idx.get("real.png")).toBe("/v/real.png");
  });

  it("first match wins on a duplicated basename", async () => {
    const ports = fakePorts({
      // walk order: top-level `a.png` is visited before `sub/`'s.
      "/v": [file("a.png"), dir("sub")],
      "/v/sub": [file("a.png")],
    });
    const idx = await buildMediaIndex("/v", ports);
    expect(idx.get("a.png")).toBe("/v/a.png");
  });

  it("a readDir failure on a subtree just yields a smaller index (best-effort)", async () => {
    const ports = fakePorts({
      "/v": [dir("good"), dir("broken"), file("root.png")],
      "/v/good": [file("g.png")],
      // "/v/broken" intentionally missing → readDir throws, swallowed.
    });
    const idx = await buildMediaIndex("/v", ports);
    expect(idx.get("root.png")).toBe("/v/root.png");
    expect(idx.get("g.png")).toBe("/v/good/g.png");
    expect(idx.size).toBe(2);
  });
});

describe("createImportPorts.setDeliberateFolders", () => {
  it("unions the importer's folders with the vault's existing set", async () => {
    prefsRead.mockResolvedValue({ deliberate_folders: ["Existing/"] });
    setDeliberateFolders.mockResolvedValue(undefined);
    const ports = createImportPorts("/root");
    await ports.setDeliberateFolders(["New/", "Existing/"]);
    const written = setDeliberateFolders.mock.calls[0]![0] as string[];
    expect([...written].sort()).toEqual(["Existing/", "New/"]);
  });

  it("falls back to just the importer's set when prefsRead fails", async () => {
    prefsRead.mockRejectedValue(new Error("SlotNotUnlocked"));
    setDeliberateFolders.mockResolvedValue(undefined);
    const ports = createImportPorts("/root");
    await ports.setDeliberateFolders(["Only/"]);
    expect(setDeliberateFolders).toHaveBeenCalledWith(["Only/"]);
  });
});

describe("createMediaRefImporter", () => {
  const ref = (source: string) => ({
    source,
    raw: "",
    from: 0,
    to: 0,
  }) as never; // engine ImportedImageRef shape; only `.source` is read.

  it("returns ok with the first candidate that ingests", async () => {
    attachmentImport.mockResolvedValueOnce({ id: "att-1" });
    const importer = createMediaRefImporter("/v", new Map());
    const res = await importer(ref("images/a.png"));
    expect(res.ok).toBe(true);
    expect(attachmentImport).toHaveBeenCalledWith({
      kind: "path",
      path: "/v/images/a.png",
    });
  });

  it("falls through to the next candidate when the first throws", async () => {
    // root-join candidate fails; the basename-index candidate succeeds.
    attachmentImport
      .mockRejectedValueOnce(new Error("unsupported"))
      .mockResolvedValueOnce({ id: "att-2" });
    const idx = new Map([["a.png", "/v/assets/a.png"]]);
    const importer = createMediaRefImporter("/v", idx);
    const res = await importer(ref("a.png"));
    expect(res.ok).toBe(true);
    expect(attachmentImport).toHaveBeenNthCalledWith(2, {
      kind: "path",
      path: "/v/assets/a.png",
    });
  });

  it("returns { ok: false } when no candidate resolves (omitted tally)", async () => {
    attachmentImport.mockRejectedValue(new Error("nope"));
    // An absolute source emits NO root candidate and is not indexed → zero
    // candidates → ok:false without ever calling attachmentImport.
    const importer = createMediaRefImporter("/v", new Map());
    const res = await importer(ref("/etc/passwd.png"));
    expect(res).toEqual({ ok: false });
    expect(attachmentImport).not.toHaveBeenCalled();
  });
});

describe("loadExistingIdentity", () => {
  it("builds the live (folder,title) identity set from the full note list", async () => {
    noteList.mockResolvedValue(["u1", "u2", "u3"]);
    loadNoteBatch.mockResolvedValue([
      { noteUuid: "u1", title: "Alpha", folder: "Work/", updatedAt: null, trashed: null, template: false },
      { noteUuid: "u2", title: "Trashed", folder: null, updatedAt: null, trashed: "2026-01-01T00:00:00Z", template: false },
      { noteUuid: "u3", title: "Tmpl", folder: null, updatedAt: null, trashed: null, template: true },
    ]);
    const set = await loadExistingIdentity();
    expect(set.has(noteIdentityKey("Work/", "Alpha"))).toBe(true);
    // trashed + template are excluded.
    expect(set.size).toBe(1);
    expect(loadNoteBatch).toHaveBeenCalledWith(["u1", "u2", "u3"]);
  });
});
