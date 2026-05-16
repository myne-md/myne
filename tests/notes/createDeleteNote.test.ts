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
    await noteCreate("# Heading\nbody");
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
