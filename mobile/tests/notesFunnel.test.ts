// @vitest-environment jsdom
//
// Mobile's `note_update` funnel (`mobile/src/lib/notes.ts`, myne-md/myne#849
// review, C1). The mobile twin of `tests/notes/liveNote.test.ts` on the desktop
// side, and it exists because the review found the funnel in the WRONG PLACE: one
// call site in the editor screen instead of inside the primitive, which left eleven
// other writers of the open note refused by `NoteUpdateError::LiveSessionOpen`.
//
// What is under test is the primitive's own routing, which is the property the
// other eleven call sites inherit by construction:
//
//   1. a note a live session owns is written THROUGH the session, and the stateless
//      command is not invoked at all;
//   2. a note no session owns takes the stateless path unchanged, including the
//      optional expected-base hash, and a live note carries that hash to the
//      session, which checks it against its own text;
//   3. a patch that throws (rather than answering null) is NOT swallowed, because
//      that is a real failure and the caller's catch is where it belongs.

import { beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<void> => undefined),
  patchLiveNote: vi.fn(
    async (
      _noteId: string,
      _markdown: string,
      _opts?: { expectedBaseHashHex?: string; base?: string },
    ): Promise<string | null> => null,
  ),
  isLiveNote: vi.fn((_noteId: string): boolean => false),
  evictLiveNote: vi.fn(async (_noteId: string): Promise<boolean> => true),
  readLiveNote: vi.fn(async (_noteId: string): Promise<string | null> => null),
}));

vi.mock("../src/platform/core", () => ({ invoke: seam.invoke }));
vi.mock("../src/lib/liveNote", () => ({
  patchLiveNote: seam.patchLiveNote,
  isLiveNote: seam.isLiveNote,
  evictLiveNote: seam.evictLiveNote,
  readLiveNote: seam.readLiveNote,
}));

import { deleteNoteRouted, noteRead, noteUpdate } from "../src/lib/notes";

beforeEach(() => {
  seam.invoke.mockReset();
  seam.invoke.mockImplementation(async () => undefined);
  seam.patchLiveNote.mockReset();
  seam.patchLiveNote.mockResolvedValue(null);
  seam.isLiveNote.mockReset();
  seam.isLiveNote.mockReturnValue(false);
  seam.evictLiveNote.mockReset();
  seam.evictLiveNote.mockResolvedValue(true);
  seam.readLiveNote.mockReset();
  seam.readLiveNote.mockResolvedValue(null);
});

/** The `plugin:<x>|<y>` commands the primitives reached, in order. */
const commands = () => seam.invoke.mock.calls.map((c) => c[0]);

describe("reading a note a live session owns (myne-md/myne#849 review, D8)", () => {
  it("reads the SESSION, not disk, because a live peer edit is not flushed", async () => {
    // Disk lags the session until this device's next write, so every
    // read-modify-write writer that read disk patched stale text over the session
    // and deleted the peer's edit.
    seam.isLiveNote.mockReturnValue(true);
    seam.readLiveNote.mockResolvedValue("session text");
    expect(await noteRead("n1")).toBe("session text");
    expect(commands()).not.toContain("plugin:notes|note_read");
  });

  it("falls back to disk when the session closed between the check and the read", async () => {
    // Closing flushes, so disk is current again in exactly this case.
    seam.isLiveNote.mockReturnValue(true);
    seam.invoke.mockImplementation(async () => "disk text" as never);
    expect(await noteRead("n1")).toBe("disk text");
    expect(commands()).toEqual(["plugin:notes|note_read"]);
  });

  it("reads disk for a note no session owns", async () => {
    seam.invoke.mockImplementation(async () => "disk text" as never);
    expect(await noteRead("n1")).toBe("disk text");
    expect(seam.readLiveNote).not.toHaveBeenCalled();
  });
});

describe("deleting a note a live session owns (myne-md/myne#849 review, D7 + D9)", () => {
  it("evicts the session BEFORE anything is erased", async () => {
    // Evict, not close: the delete holds no hold of its own, so a release here
    // spent the editor's hold instead (D7). The policy suite pins what evict does
    // to the count; this pins that the delete path calls it, first.
    const order: string[] = [];
    seam.evictLiveNote.mockImplementation(async () => {
      order.push("evict");
      return true;
    });
    seam.invoke.mockImplementation(async (cmd: string) => {
      order.push(cmd);
      return undefined;
    });
    await deleteNoteRouted("n1");
    expect(order[0]).toBe("evict");
    expect(seam.evictLiveNote).toHaveBeenCalledWith("n1");
    expect(order).toContain("plugin:notes|note_delete");
  });

  it("refuses, and reaches no erase command, when the eviction failed", async () => {
    // A failed flush restores the holds, so the session still owns the note and its
    // next flush would put the note back. Asserted as STATE: no delete and no
    // tombstone write reached the backend.
    seam.evictLiveNote.mockResolvedValue(false);
    seam.isLiveNote.mockReturnValue(true);
    seam.readLiveNote.mockResolvedValue("body");
    await expect(deleteNoteRouted("n1")).rejects.toMatchObject({ kind: "LiveSessionOpen" });
    expect(commands()).not.toContain("plugin:notes|note_delete");
    expect(commands()).not.toContain("plugin:notes|note_update");
    expect(seam.patchLiveNote).not.toHaveBeenCalled();
  });
});

describe("the funnel is in the primitive, so every writer inherits it", () => {
  it("routes through the session when one owns the note, and never invokes note_update", async () => {
    seam.patchLiveNote.mockResolvedValue("body");
    await noteUpdate("n1", "body");

    expect(seam.patchLiveNote).toHaveBeenCalledWith("n1", "body", {
      expectedBaseHashHex: undefined,
      base: undefined,
    });
    expect(seam.invoke).not.toHaveBeenCalled();
  });

  it("takes the stateless path when no session owns the note", async () => {
    await noteUpdate("n1", "body");

    expect(seam.invoke).toHaveBeenCalledWith("plugin:notes|note_update", {
      noteId: "n1",
      plaintext: "body",
    });
  });

  it("passes the expected-base hash and the base to the session on the live path (D8)", async () => {
    // The task panel's keep-both sequence rests on this hash: the session checks it
    // against its own text, so a peer edit sitting unflushed in the session answers
    // BaseMismatch instead of being overwritten.
    seam.patchLiveNote.mockResolvedValue("body");
    await noteUpdate("n1", "body", "deadbeef", "prev");
    expect(seam.patchLiveNote).toHaveBeenCalledWith("n1", "body", {
      expectedBaseHashHex: "deadbeef",
      base: "prev",
    });
    expect(seam.invoke).not.toHaveBeenCalled();
  });

  it("lets a BaseMismatch from the session reach the caller's keep-both branch", async () => {
    seam.patchLiveNote.mockRejectedValue({ kind: "BaseMismatch" });
    await expect(noteUpdate("n1", "body", "deadbeef")).rejects.toEqual({ kind: "BaseMismatch" });
    expect(seam.invoke).not.toHaveBeenCalled();
  });

  it("passes the expected-base hash through the stateless path unchanged", async () => {
    // §11.3: the stateless command never receives `base`, which only the session
    // can merge against.
    await noteUpdate("n1", "body", "deadbeef", "prev");
    expect(seam.invoke).toHaveBeenCalledWith("plugin:notes|note_update", {
      noteId: "n1",
      plaintext: "body",
      expectedBaseHashHex: "deadbeef",
    });
  });

  it("does not swallow a real patch failure", async () => {
    // `null` means "no session, use the stateless path". A THROWN error means the
    // session took the write and failed, which must reach the caller's catch rather
    // than being silently retried against a refused command.
    seam.patchLiveNote.mockRejectedValue({ kind: "Io" });
    await expect(noteUpdate("n1", "body")).rejects.toEqual({ kind: "Io" });
    expect(seam.invoke).not.toHaveBeenCalled();
  });

  it("is the ONLY place the stateless command is invoked", async () => {
    // The C1 defect in one assertion: if a second call site grows back, the
    // funnel can be bypassed again and a refused save returns while this file
    // stays green.
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    // `process.cwd()` is `mobile/` under this runner, and `import.meta.url` is not a
    // file URL in the jsdom environment (it resolved to `/src` once, which the
    // runner reported as ENOENT rather than as a passing empty scan).
    const proc = (globalThis as unknown as { process: { cwd(): string } }).process;
    const root = join(proc.cwd(), "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(full)) files.push(full);
      }
    };
    walk(root);
    const callers = files.filter((f) => {
      const text: string = readFileSync(f, "utf8");
      return text.includes('"plugin:notes|note_update"');
    });
    expect(callers.map((f) => f.slice(root.length + 1))).toEqual(["lib/notes.ts"]);
  });
});
