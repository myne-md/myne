// Unit tests for the sync-delete reroute in `src/notes/deleteNote.ts`
// (deleteNoteRouted + tombstoneNote + isSyncConfigured). The
// security-relevant invariant: NO bare unlink under sync. When a sync
// endpoint is configured (or forceTombstone is set) a delete becomes a
// `deleted: <RFC3339>` tombstone version written via note_update — it must
// NOT call the hard note_delete (which would risk resurrection through the
// blind server). When sync is unconfigured (endpoint null / probe throws)
// it falls back to the hard cryptographic-erase note_delete and writes NO
// tombstone. Mirrors `trashNote.test.ts` for the invoke-mock + note-op
// mock shape.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  deleteNoteRouted,
  tombstoneNote,
} from "../../src/notes/deleteNote";

beforeEach(() => invokeMock.mockReset());
afterEach(() => invokeMock.mockReset());

// Routes the four commands the reroute can touch. `endpoint` controls the
// sync-configured branch: a string → configured (tombstone), null →
// unconfigured (hard delete). `read` is the existing note plaintext.
function routeSync(opts: {
  endpoint: string | null;
  read?: string;
}): void {
  const { endpoint, read = "# Hello\nbody\n" } = opts;
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "plugin:sync|sync_get_endpoint")
      return Promise.resolve({ endpoint_url: endpoint });
    if (cmd === "plugin:notes|note_read") return Promise.resolve(read);
    if (cmd === "plugin:notes|note_update") return Promise.resolve(undefined);
    if (cmd === "plugin:notes|note_delete") return Promise.resolve(undefined);
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

function calledCommands(): string[] {
  return invokeMock.mock.calls.map(([cmd]) => cmd as string);
}

function lastUpdateBody(): string {
  const call = invokeMock.mock.calls.find(
    ([cmd]) => cmd === "plugin:notes|note_update",
  );
  return (call?.[1] as { plaintext: string }).plaintext;
}

const RFC3339 = /deleted: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/;

describe("deleteNoteRouted — sync-configured branch (endpoint present)", () => {
  it("writes a `deleted: <RFC3339>` tombstone via note_update", async () => {
    routeSync({ endpoint: "https://sync.example/" });
    await deleteNoteRouted("id-1");
    const body = lastUpdateBody();
    expect(body).toMatch(RFC3339);
    expect(body).toContain("# Hello");
  });

  it("does NOT call the hard note_delete (no bare unlink under sync)", async () => {
    routeSync({ endpoint: "https://sync.example/" });
    await deleteNoteRouted("id-1");
    expect(calledCommands()).toContain("plugin:notes|note_update");
    expect(calledCommands()).not.toContain("plugin:notes|note_delete");
  });

  it("passes the noteId straight through to the tombstone update", async () => {
    routeSync({ endpoint: "https://sync.example/" });
    await deleteNoteRouted("note-xyz");
    const updateCall = invokeMock.mock.calls.find(
      ([cmd]) => cmd === "plugin:notes|note_update",
    );
    expect((updateCall?.[1] as { noteId: string }).noteId).toBe("note-xyz");
  });
});

describe("deleteNoteRouted — sync-unconfigured branch (endpoint null)", () => {
  it("falls back to the hard note_delete", async () => {
    routeSync({ endpoint: null });
    await deleteNoteRouted("id-2");
    const deleteCall = invokeMock.mock.calls.find(
      ([cmd]) => cmd === "plugin:notes|note_delete",
    );
    expect(deleteCall).toBeDefined();
    expect((deleteCall?.[1] as { noteId: string }).noteId).toBe("id-2");
  });

  it("writes NO tombstone (note_update never called, note_read never read)", async () => {
    routeSync({ endpoint: null });
    await deleteNoteRouted("id-2");
    expect(calledCommands()).not.toContain("plugin:notes|note_update");
    expect(calledCommands()).not.toContain("plugin:notes|note_read");
  });

  it("falls back to the hard note_delete when the endpoint probe throws", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:sync|sync_get_endpoint")
        return Promise.reject(new Error("sync plugin unavailable"));
      if (cmd === "plugin:notes|note_delete") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
    await deleteNoteRouted("id-3");
    expect(calledCommands()).toContain("plugin:notes|note_delete");
    expect(calledCommands()).not.toContain("plugin:notes|note_update");
  });
});

describe("deleteNoteRouted — forceTombstone overrides the endpoint probe", () => {
  it("tombstones even when the endpoint is null (no probe, no hard delete)", async () => {
    routeSync({ endpoint: null });
    await deleteNoteRouted("id-4", true);
    expect(lastUpdateBody()).toMatch(RFC3339);
    expect(calledCommands()).toContain("plugin:notes|note_update");
    expect(calledCommands()).not.toContain("plugin:notes|note_delete");
    expect(calledCommands()).not.toContain("plugin:sync|sync_get_endpoint");
  });

  it("forceTombstone=false hard-deletes without probing the endpoint", async () => {
    routeSync({ endpoint: "https://sync.example/" });
    await deleteNoteRouted("id-5", false);
    expect(calledCommands()).toContain("plugin:notes|note_delete");
    expect(calledCommands()).not.toContain("plugin:notes|note_update");
    expect(calledCommands()).not.toContain("plugin:sync|sync_get_endpoint");
  });
});

describe("tombstoneNote — direct tombstone write", () => {
  it("preserves an existing folder: while adding the deleted: marker", async () => {
    routeSync({ endpoint: "https://sync.example/", read: "---\nfolder: Projects/\n---\n\nbody" });
    await tombstoneNote("id-6");
    const body = lastUpdateBody();
    expect(body).toContain("folder: Projects/");
    expect(body).toMatch(RFC3339);
  });

  it("rejects when note_read rejects", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:notes|note_read")
        return Promise.reject({ kind: "NoteNotFound" });
      return Promise.resolve(undefined);
    });
    await expect(tombstoneNote("id-x")).rejects.toMatchObject({
      kind: "NoteNotFound",
    });
  });
});

// myne-md/myne#849 review (D9): the evict-before-delete and the refusal under a
// session that survived its close had no test, so removing either left the suite
// green. Driven over the REAL desktop shim (`src/notes/liveNote.ts`) with only the
// IPC mocked, so the hold the policy keeps is the one `deleteNoteRouted` reads.
describe("deleteNoteRouted: a note with an open live session", () => {
  function routeLive(closeFails: boolean): void {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:live|live_session_open") return Promise.resolve(undefined);
      if (cmd === "plugin:live|live_session_close")
        return closeFails ? Promise.reject({ kind: "Io", detail: "disk full" }) : Promise.resolve(undefined);
      if (cmd === "plugin:sync|sync_get_endpoint") return Promise.resolve({ endpoint_url: null });
      if (cmd === "plugin:notes|note_delete") return Promise.resolve(undefined);
      if (cmd === "plugin:notes|note_update") return Promise.resolve(undefined);
      if (cmd === "plugin:notes|note_read") return Promise.resolve("# Hello\n");
      return Promise.resolve(undefined);
    });
  }

  it("evicts the session before the erase reaches the backend", async () => {
    const { isLiveNote, openLiveNote } = await import("../../src/notes/liveNote");
    routeLive(false);
    await openLiveNote("live-close-first");
    invokeMock.mockClear();
    await deleteNoteRouted("live-close-first");
    const cmds = calledCommands();
    expect(cmds).toContain("plugin:live|live_session_close");
    expect(cmds.indexOf("plugin:live|live_session_close")).toBeLessThan(
      cmds.indexOf("plugin:notes|note_delete"),
    );
    expect(isLiveNote("live-close-first")).toBe(false);
  });

  it("refuses, reaches no erase command, and keeps the pane's hold when the session survived its close", async () => {
    const { closeLiveNote, isLiveNote, openLiveNote } = await import("../../src/notes/liveNote");
    routeLive(true);
    await openLiveNote("live-survives");
    invokeMock.mockClear();
    await expect(deleteNoteRouted("live-survives")).rejects.toMatchObject({ kind: "LiveSessionOpen" });
    expect(calledCommands()).not.toContain("plugin:notes|note_delete");
    expect(calledCommands()).not.toContain("plugin:notes|note_update");
    // The pane's hold came back, so the pane's own release is still the one that
    // closes the session rather than a no-op against a count the delete spent.
    expect(isLiveNote("live-survives")).toBe(true);
    routeLive(false);
    invokeMock.mockClear();
    await closeLiveNote("live-survives");
    expect(calledCommands()).toContain("plugin:live|live_session_close");
    expect(isLiveNote("live-survives")).toBe(false);
  });

  it("with TWO panes holding the note, still evicts in one step and erases (review D7)", async () => {
    // The defect this pins: a delete path owns no hold, so `closeLiveNote` from it
    // released ONE pane's hold, left the other's, and the refusal then fired on a
    // note whose session was open only because the count was off by one.
    const { closeLiveNote, isLiveNote, openLiveNote } = await import("../../src/notes/liveNote");
    routeLive(false);
    await openLiveNote("live-two-panes");
    await openLiveNote("live-two-panes");
    invokeMock.mockClear();
    await deleteNoteRouted("live-two-panes");
    const cmds = calledCommands();
    expect(cmds.filter((c) => c === "plugin:live|live_session_close")).toHaveLength(1);
    expect(cmds).toContain("plugin:notes|note_delete");
    expect(isLiveNote("live-two-panes")).toBe(false);
    // The two panes' later releases find nothing to release and close nothing.
    invokeMock.mockClear();
    await closeLiveNote("live-two-panes");
    await closeLiveNote("live-two-panes");
    expect(calledCommands()).not.toContain("plugin:live|live_session_close");
  });
});
