// The desktop note funnels on a note a live session owns (myne-md/myne#849
// review, D8): `noteRead` reads the SESSION, and `noteUpdate` carries the
// caller's expected-base hash to the session.
//
// Driven over the REAL desktop shim (`src/notes/liveNote.ts`) and the real
// bindings with only the IPC mocked, so the hold `noteRead` consults is the one
// `openLiveNote` takes, and the args asserted are the ones that cross the wire.
// The mobile twin of the read half is `mobile/tests/notesFunnel.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { closeLiveNote, isLiveNote, openLiveNote } from "../../src/notes/liveNote";
import { noteRead } from "../../src/notes/readNote";
import { noteUpdate } from "../../src/notes/updateNote";

/** `readRejects` makes the session read answer NotOpen (closed in between). */
function route(opts: { readRejects?: boolean } = {}): void {
  invokeMock.mockImplementation((cmd: string, args?: { markdown?: string }) => {
    if (cmd === "plugin:live|live_session_open") return Promise.resolve(undefined);
    if (cmd === "plugin:live|live_session_close") return Promise.resolve(undefined);
    if (cmd === "plugin:live|live_session_read")
      return opts.readRejects ? Promise.reject({ kind: "NotOpen" }) : Promise.resolve("session text");
    if (cmd === "plugin:live|live_session_patch_frontmatter")
      return Promise.resolve(args?.markdown ?? "");
    if (cmd === "plugin:notes|note_read") return Promise.resolve("disk text");
    if (cmd === "plugin:notes|note_update") return Promise.resolve(undefined);
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

function commands(): string[] {
  return invokeMock.mock.calls.map(([cmd]) => cmd as string);
}

beforeEach(async () => {
  route();
  for (const id of ["n"]) {
    while (isLiveNote(id)) await closeLiveNote(id);
  }
  invokeMock.mockClear();
});

describe("noteRead on desktop", () => {
  it("reads a live note from the session and never touches disk", async () => {
    await openLiveNote("n");
    invokeMock.mockClear();
    expect(await noteRead("n")).toBe("session text");
    expect(commands()).toEqual(["plugin:live|live_session_read"]);
  });

  it("falls back to disk when the session closed between the check and the read", async () => {
    await openLiveNote("n");
    route({ readRejects: true });
    invokeMock.mockClear();
    expect(await noteRead("n")).toBe("disk text");
    expect(commands()).toEqual(["plugin:live|live_session_read", "plugin:notes|note_read"]);
  });

  it("reads disk for a note no session owns, with no session hop", async () => {
    expect(await noteRead("n")).toBe("disk text");
    expect(commands()).toEqual(["plugin:notes|note_read"]);
  });
});

describe("noteUpdate on desktop, live path", () => {
  it("passes the caller's expected-base hash and base to the session", async () => {
    await openLiveNote("n");
    invokeMock.mockClear();
    await noteUpdate("n", "next", "abc123", "prev");
    expect(invokeMock).toHaveBeenCalledWith("plugin:live|live_session_patch_frontmatter", {
      noteId: "n",
      markdown: "next",
      expectedBaseHashHex: "abc123",
      base: "prev",
    });
    expect(commands()).not.toContain("plugin:notes|note_update");
  });

  it("sends neither optional key when the caller passed none", async () => {
    await openLiveNote("n");
    invokeMock.mockClear();
    await noteUpdate("n", "next");
    const call = invokeMock.mock.calls.find(
      ([cmd]) => cmd === "plugin:live|live_session_patch_frontmatter",
    );
    // Key by key, not `toHaveBeenCalledWith`, which treats a key present with the
    // value `undefined` as equal to an absent one.
    expect(Object.keys(call?.[1] as object).sort()).toEqual(["markdown", "noteId"]);
  });

  it("propagates a BaseMismatch from the session and writes nothing stateless", async () => {
    await openLiveNote("n");
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:live|live_session_patch_frontmatter")
        return Promise.reject({ kind: "BaseMismatch" });
      return Promise.resolve(undefined);
    });
    invokeMock.mockClear();
    await expect(noteUpdate("n", "next", "stale")).rejects.toMatchObject({ kind: "BaseMismatch" });
    expect(commands()).not.toContain("plugin:notes|note_update");
    expect(isLiveNote("n")).toBe(true);
  });
});
