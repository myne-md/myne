// Unit tests for `src/notes/moveNote.ts` (move + bulk move) and the
// `createNote(folder)` a2 create-timing path. Move reads the note, rewrites
// the `folder:` frontmatter (set / delete via patchFolderField), bumps
// `updated:`, and re-encrypts. Grill 2026-05-29 Q7 (a2 create + move-only
// folder writes) + Q8 (bulk = N independent best-effort moves).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { moveNote, bulkMoveNotes } from "../../src/notes/moveNote";
import { createNote } from "../../src/notes/createNote";
import { buildInitialPlaintext } from "../../dialect/src/surgery";

beforeEach(() => invokeMock.mockReset());
afterEach(() => invokeMock.mockReset());

/** Route invoke by command: note_read → `read`, note_update → undefined. */
function routeReadThenUpdate(read: string): void {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "plugin:notes|note_read") return Promise.resolve(read);
    if (cmd === "plugin:notes|note_update") return Promise.resolve(undefined);
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

/** Extract the plaintext arg of the (single) note_update call. */
function lastUpdateBody(): string {
  const call = invokeMock.mock.calls.find(
    ([cmd]) => cmd === "plugin:notes|note_update",
  );
  return (call?.[1] as { plaintext: string }).plaintext;
}

describe("moveNote — to a folder", () => {
  it("writes folder: into a root note and bumps updated:", async () => {
    routeReadThenUpdate("# Hello\nbody\n");
    await moveNote("id-1", "Projects/");
    const body = lastUpdateBody();
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toContain("folder: Projects/");
    expect(body).toContain("# Hello");
    expect(body).toMatch(/updated: \d{4}-\d{2}-\d{2}T/);
  });

  it("replaces an existing folder: value (state C)", async () => {
    routeReadThenUpdate("---\nfolder: Old/\n---\n\nbody");
    await moveNote("id-2", "New/Sub/");
    const body = lastUpdateBody();
    expect(body).toContain("folder: New/Sub/");
    expect(body).not.toContain("folder: Old/");
  });

  it("normalizes a non-canonical folder value to trailing-slash", async () => {
    routeReadThenUpdate("body\n");
    await moveNote("id-3", "Projects/Myne"); // no trailing slash
    expect(lastUpdateBody()).toContain("folder: Projects/Myne/");
  });
});

describe("moveNote — to root (null = state-D delete)", () => {
  it("removes a single-field FM block byte-identical to a root note", async () => {
    // Foldered note with body → move-to-root strips the whole FM block.
    routeReadThenUpdate("---\nfolder: Projects/\n---\n\n# Body");
    await moveNote("id-4", null);
    const body = lastUpdateBody();
    // The folder field is gone; updated: stamping re-adds an FM block
    // (move is a modification → updated: must advance), but folder: is absent.
    expect(body).not.toContain("folder:");
    expect(body).toContain("# Body");
    expect(body).toMatch(/updated: \d{4}-\d{2}-\d{2}T/);
  });

  it("keeps other FM keys when deleting folder: (state-D partial)", async () => {
    routeReadThenUpdate("---\ntitle: Foo\nfolder: Projects/\n---\n\nbody");
    await moveNote("id-5", null);
    const body = lastUpdateBody();
    expect(body).toContain("title: Foo");
    expect(body).not.toContain("folder:");
  });
});

describe("moveNote — error propagation", () => {
  it("rejects when note_read rejects", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:notes|note_read")
        return Promise.reject({ kind: "NoteNotFound" });
      return Promise.resolve(undefined);
    });
    await expect(moveNote("id-x", "Projects/")).rejects.toMatchObject({
      kind: "NoteNotFound",
    });
  });
});

describe("bulkMoveNotes — N independent best-effort moves", () => {
  it("moves all notes and reports them as moved", async () => {
    routeReadThenUpdate("body\n");
    const result = await bulkMoveNotes(["a", "b", "c"], "Archive/");
    expect(result.moved.sort()).toEqual(["a", "b", "c"]);
    expect(result.failed).toEqual([]);
  });

  it("reports per-note failures without aborting the rest", async () => {
    invokeMock.mockImplementation((cmd: string, args: unknown) => {
      const id = (args as { noteId?: string }).noteId;
      if (cmd === "plugin:notes|note_read") {
        if (id === "bad") return Promise.reject({ kind: "CannotDecrypt" });
        return Promise.resolve("body\n");
      }
      return Promise.resolve(undefined);
    });
    const result = await bulkMoveNotes(["ok1", "bad", "ok2"], "Archive/");
    expect(result.moved.sort()).toEqual(["ok1", "ok2"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.noteId).toBe("bad");
  });

  it("returns empty result for an empty input", async () => {
    const result = await bulkMoveNotes([], "Archive/");
    expect(result).toEqual({ moved: [], failed: [] });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("createNote(folder) — a2 create-timing", () => {
  // myne#653 added `title: ""` to BOTH shapes. Before it, the two paths
  // disagreed, a foldered create carried frontmatter and a root create sent
  // nothing. And the root note came out with nowhere to put its name. These
  // assert the bytes rather than a call count precisely because that is what
  // went wrong: the write happened, with the wrong payload.
  it("sends a foldered FM block at create for a folder", async () => {
    invokeMock.mockResolvedValueOnce("new-id");
    await createNote("Projects/");
    const [, args] = invokeMock.mock.calls[0] ?? [];
    expect((args as { plaintext: string }).plaintext).toBe(
      '---\nfolder: Projects/\ntitle: ""\n---\n\n',
    );
  });

  it("sends a title-carrying FM block for a root note (no arg / null)", async () => {
    invokeMock.mockResolvedValue("new-id");
    await createNote();
    expect((invokeMock.mock.calls[0]?.[1] as { plaintext: string }).plaintext).toBe(
      '---\ntitle: ""\n---\n\n',
    );
    invokeMock.mockClear();
    await createNote(null);
    expect((invokeMock.mock.calls[0]?.[1] as { plaintext: string }).plaintext).toBe(
      '---\ntitle: ""\n---\n\n',
    );
  });

  it("normalizes the folder before writing", async () => {
    invokeMock.mockResolvedValueOnce("new-id");
    await createNote("Projects/Myne"); // no trailing slash
    expect((invokeMock.mock.calls[0]?.[1] as { plaintext: string }).plaintext).toBe(
      '---\nfolder: Projects/Myne/\ntitle: ""\n---\n\n',
    );
  });

  // The `dialect/` primitive keeps its identity: myne#653 patched the title on
  // TOP of it at the action layer precisely so the state-D folder-delete
  // collapse stays byte-identical to an FM-less root note. If this ever fails,
  // the fix moved into the wrong layer.
  it("leaves buildInitialPlaintext(null) empty, the state-D symmetry", () => {
    expect(buildInitialPlaintext(null)).toBe("");
  });
});


// ---------------------------------------------------------------------------
// myne-md/myne#613: a folder is registered the first time a note lands in it.
//
// Every assertion here keys off what reached `invoke`, never off a function
// name: the defect this closes was a WRITE with the wrong payload, and a spy on
// the binding would have passed for both the broken and the fixed version. Each
// block also states a floor, so a call site that silently stops firing fails
// rather than passing vacuously.
// ---------------------------------------------------------------------------

/** Every `prefs|set_deliberate_folders` payload that reached `invoke`. */
function deliberateWrites(): Array<{ add?: string[]; remove?: string[] }> {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "plugin:prefs|set_deliberate_folders")
    .map(([, args]) => (args as { mutation: { add?: string[]; remove?: string[] } }).mutation);
}

/** Route note_read / note_update AND accept the prefs write. */
function routeWithPrefs(read: string, updateFails = false): void {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "plugin:notes|note_read") return Promise.resolve(read);
    if (cmd === "plugin:notes|note_update") {
      return updateFails ? Promise.reject(new Error("nope")) : Promise.resolve(undefined);
    }
    if (cmd === "plugin:prefs|set_deliberate_folders") return Promise.resolve(0);
    return Promise.resolve(undefined);
  });
}

/** Let the fire-and-forget registration settle before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("moveNote folder registration (myne-md/myne#613)", () => {
  it("registers the destination as an ADD, claiming no removal", async () => {
    routeWithPrefs("# Hello\n");
    await moveNote("id-1", "Projects/");
    await settle();
    const writes = deliberateWrites();
    expect(writes).toHaveLength(1); // floor: the call site fired at all
    expect(writes[0]?.add).toEqual(["Projects/"]);
    // The whole point of the verb payload: a move can never claim a deletion,
    // whatever the caller's view of the set was. A `remove` here would be the
    // lost-update-becomes-distributed-delete defect back again.
    expect(writes[0]?.remove ?? []).toEqual([]);
  });

  it("registers the NORMALIZED path, which is what the note now carries", async () => {
    routeWithPrefs("# Hello\n");
    await moveNote("id-1", "Projects/Myne"); // no trailing slash
    await settle();
    expect(deliberateWrites()[0]?.add).toEqual(["Projects/Myne/"]);
  });

  it("registers nothing for a move to the vault root", async () => {
    routeWithPrefs("---\nfolder: Projects/\n---\n\n# Hello\n");
    await moveNote("id-1", null);
    await settle();
    // Leaving a folder is not deleting it, so the folder the note LEFT is
    // untouched too: no write of any kind.
    expect(deliberateWrites()).toEqual([]);
  });
});

describe("bulkMoveNotes: one prefs write per operation (myne-md/myne#613)", () => {
  it("issues exactly ONE write for fifty notes, not fifty", async () => {
    routeWithPrefs("# Hello\n");
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    const r = await bulkMoveNotes(ids, "Projects/");
    await settle();
    expect(r.moved).toHaveLength(50); // floor: the moves really happened
    // Asserted on the COUNT rather than the end state, deliberately: an
    // end-state assertion passes for the fifty-write implementation too, and
    // each write re-encrypts the whole `vault.prefs` blob.
    expect(deliberateWrites()).toHaveLength(1);
    expect(deliberateWrites()[0]?.add).toEqual(["Projects/"]);
  });

  it("registers nothing when every note in the bulk failed", async () => {
    routeWithPrefs("# Hello\n", true);
    const r = await bulkMoveNotes(["a", "b", "c"], "Projects/");
    await settle();
    expect(r.failed).toHaveLength(3); // floor: they really all failed
    expect(deliberateWrites()).toEqual([]);
  });

  it("registers once when only some of the bulk landed", async () => {
    let reads = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:notes|note_read") {
        reads += 1;
        return reads === 2 ? Promise.reject(new Error("nope")) : Promise.resolve("# Hello\n");
      }
      if (cmd === "plugin:notes|note_update") return Promise.resolve(undefined);
      return Promise.resolve(0);
    });
    const r = await bulkMoveNotes(["a", "b", "c"], "Projects/");
    await settle();
    expect(r.moved).toHaveLength(2);
    expect(r.failed).toHaveLength(1);
    expect(deliberateWrites()).toHaveLength(1);
    expect(deliberateWrites()[0]?.add).toEqual(["Projects/"]);
  });
});

describe("moveNote: the merge base it hands a live session (myne-md/myne#849 review round 4)", () => {
  it("passes the text it READ as the base, so a peer edit landing between the read and the write survives", async () => {
    // A session owns the note. Its read answers through the session, and the write
    // goes through `live_session_patch_frontmatter`; the base it carries is what
    // lets the core merge rather than replace when a peer edit lands in between.
    const live = await import("../../src/notes/liveNote");
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:live|live_session_open") return Promise.resolve(undefined);
      if (cmd === "plugin:live|live_session_read") return Promise.resolve("# Hello\nbody\n");
      if (cmd === "plugin:live|live_session_patch_frontmatter") return Promise.resolve("merged");
      if (cmd === "plugin:live|live_session_close") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
    await live.openLiveNote("id-live");
    try {
      await moveNote("id-live", "Projects/");
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === "plugin:live|live_session_patch_frontmatter");
      expect((call?.[1] as { base?: string }).base).toBe("# Hello\nbody\n");
    } finally {
      await live.evictLiveNote("id-live");
    }
  });
});
