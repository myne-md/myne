// Unit tests for `src/notes/createNote.ts` + `src/notes/deleteNote.ts`.
// Verifies the Q8 zero-payload create action + the noteId pass-through
// for delete; no optimistic UI logic at the helper layer (the caller —
// `sidebarState` / UI components — owns optimistic UI per Q13).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { createNote, noteCreate } from "../../src/notes/createNote";
import { deleteNote, noteDelete } from "../../src/notes/deleteNote";

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  invokeMock.mockReset();
});

describe("createNote — Q8 zero-payload action", () => {
  it("invokes note_create with empty plaintext", async () => {
    invokeMock.mockResolvedValueOnce("00000000-0000-7000-8000-000000000001");
    const id = await createNote();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("plugin:notes|note_create", {
      plaintext: "",
    });
    expect(id).toBe("00000000-0000-7000-8000-000000000001");
  });

  it("returns the backend-minted NoteId verbatim", async () => {
    invokeMock.mockResolvedValueOnce("01ABCDEF-0123-7456-8789-ABCDEF012345");
    const id = await createNote();
    expect(id).toBe("01ABCDEF-0123-7456-8789-ABCDEF012345");
  });

  it("rejects with the IPC error when note_create rejects", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "VaultNotUnlocked" });
    await expect(createNote()).rejects.toMatchObject({
      kind: "VaultNotUnlocked",
    });
  });
});

describe("noteCreate — IPC primitive with caller-supplied plaintext", () => {
  it("invokes note_create with the caller's plaintext (non-empty allowed)", async () => {
    invokeMock.mockResolvedValueOnce("some-id");
    await noteCreate("# Heading\nbody", null);
    expect(invokeMock).toHaveBeenCalledWith("plugin:notes|note_create", {
      plaintext: "# Heading\nbody",
    });
  });
});

describe("deleteNote — noteId pass-through", () => {
  it("invokes note_delete with the provided noteId verbatim", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await deleteNote("00000000-0000-7000-8000-000000000abc");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("plugin:notes|note_delete", {
      noteId: "00000000-0000-7000-8000-000000000abc",
    });
  });

  it("rejects with the IPC error when note_delete rejects", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "NoteNotFound" });
    await expect(deleteNote("missing-id")).rejects.toMatchObject({
      kind: "NoteNotFound",
    });
  });

  it("deleteNote and noteDelete are the same function (alias)", () => {
    expect(deleteNote).toBe(noteDelete);
  });
});

// ---------------------------------------------------------------------------
// myne-md/myne#613 (pr-review): at-fill registers at the CHOKEPOINT.
//
// It first landed at four surfaces, and the daily note, a note from a template,
// a folder note, a duplicate, a drawing, every template instantiation and the
// browser clipper registered nothing at all, while decision 0541 claimed the
// rule for all of them. The unlock back-fill did not cover it either, because it
// walks LIVE notes: a daily folder emptied by TRASHING its notes stayed gone,
// which is this issue's own defect surviving its own fix.
//
// `folder` is required rather than defaulted so the compiler names every create
// path. It named eight, one of which (the clipper) nobody had listed.
// ---------------------------------------------------------------------------

/** Every `prefs|set_deliberate_folders` mutation that reached `invoke`. */
function deliberateWrites(): Array<{ add?: string[]; remove?: string[] }> {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "plugin:prefs|set_deliberate_folders")
    .map(([, args]) => (args as { mutation: { add?: string[]; remove?: string[] } }).mutation);
}

/** Let the fire-and-forget registration settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("noteCreate: the folder a note lands in is registered here", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "plugin:notes|note_create"
        ? Promise.resolve("new-id")
        : Promise.resolve(0),
    );
  });

  it("registers the folder as an ADD, claiming no removal", async () => {
    await noteCreate("body", "Projects/");
    await settle();
    const w = deliberateWrites();
    expect(w).toHaveLength(1); // floor: it fired at all
    expect(w[0]?.add).toEqual(["Projects/"]);
    // A create can never claim a deletion, whatever the caller's view of the set
    // was. A `remove` here is the defect this issue closed, one layer over.
    expect(w[0]?.remove ?? []).toEqual([]);
  });

  it("normalizes before registering, so one folder is not two entries", async () => {
    await noteCreate("body", "Projects/Myne"); // no trailing slash
    await settle();
    expect(deliberateWrites()[0]?.add).toEqual(["Projects/Myne/"]);
  });

  it("registers nothing for a root note", async () => {
    await noteCreate("body", null);
    await settle();
    expect(deliberateWrites()).toEqual([]);
  });

  it("still returns the id when the registration fails", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "plugin:notes|note_create"
        ? Promise.resolve("new-id")
        : Promise.reject(new Error("prefs write failed")),
    );
    // The note is what the user asked for; remembering the folder is the extra.
    await expect(noteCreate("body", "Projects/")).resolves.toBe("new-id");
    await settle();
  });
});
