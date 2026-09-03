// Obsidian importer ports — the IO-bound helpers (MYND-53) that the existing
// `import-ports.test.ts` deliberately leaves out: `buildMediaIndex` (recursive
// walk + dot-skip + first-match-wins), `createImportPorts.setDeliberateFolders`
// (prefs union + read-failure fallback), `createMediaRefImporter` (candidate
// fall-through), and `loadExistingIdentity`. All Tauri/IPC seams are mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock every IO seam ports.ts pulls in. ---
const prefsRead = vi.fn();
const mutateDeliberateFoldersMock = vi.fn();
const noteCreate = vi.fn();
const noteList = vi.fn();
const loadNoteBatch = vi.fn();
const attachmentImport = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../src/lib/prefs", async (importOriginal) => ({
  prefsRead: (...a: unknown[]) => prefsRead(...a),
  mutateDeliberateFolders: (...a: unknown[]) => mutateDeliberateFoldersMock(...a),
  // The REAL derivation, not a copy of it. It is what decides whether a
  // stale view can claim a deletion (myne-md/myne#613), so a stub here would
  // test the stub, and a hand-copy would be one more place for the real one
  // to drift away from.
  mutationFrom: (await importOriginal<typeof import("../../src/lib/prefs")>()).mutationFrom,
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
    mutateDeliberateFoldersMock,
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
    setDeliberateFolders: async () => 0, // nothing refused for budget (myne-md/myne#613)
  };
}

const file = (name: string): ImportDirEntry => ({ name, isDir: false, link: null });
const dir = (name: string): ImportDirEntry => ({ name, isDir: true, link: null });

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
  it("states an ADD and never a whole set", async () => {
    mutateDeliberateFoldersMock.mockResolvedValue(undefined);
    const ports = createImportPorts("/root");
    await ports.setDeliberateFolders(["New/", "Existing/"]);
    expect(mutateDeliberateFoldersMock).toHaveBeenCalledWith({
      add: ["New/", "Existing/"],
    });
  });

  it("never reads prefs, so a read failure cannot reach the write", async () => {
    // This replaces a test that asserted the OPPOSITE and was right to at the
    // time: the port used to read the stored set, union its own folders in, and
    // write the whole thing back, falling back to the EMPTY set when the read
    // failed. Under myne-md/myne#613's removal discipline that fallback would
    // have written an absence it had never checked, which the merge then applies
    // as a delete on every device: one transient prefs read error during an
    // import, and every registered empty folder in the vault is gone.
    //
    // The fix was to stop needing the read. Asserted as "prefsRead is not
    // called" rather than as "the fallback behaves well", because a fallback
    // that cannot be reached is weaker evidence than a read that does not exist.
    prefsRead.mockRejectedValue(new Error("SlotNotUnlocked"));
    mutateDeliberateFoldersMock.mockResolvedValue(undefined);
    const ports = createImportPorts("/root");
    await ports.setDeliberateFolders(["Only/"]);
    expect(prefsRead).not.toHaveBeenCalled();
    expect(mutateDeliberateFoldersMock).toHaveBeenCalledWith({ add: ["Only/"] });
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
