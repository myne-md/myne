// myne-md/myne#613: `moveNoteToFolder` registers its destination so the folder
// survives its last note leaving. The desktop twin is `tests/notes/moveNote.test.ts`
// in the main tree; registration sites are per client, so that test proves
// nothing about this one and this file exists rather than being inherited.
//
// Keyed off what reached `invoke`, never off the binding's name: the defect
// this closes was a WRITE with the wrong payload, and a name spy passes for
// both versions.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { moveNoteToFolder } from "../src/lib/note-organize";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "plugin:notes|note_read") return Promise.resolve("# Hello\n");
    if (cmd === "plugin:notes|note_update") return Promise.resolve(undefined);
    if (cmd === "plugin:prefs|set_deliberate_folders") return Promise.resolve(0);
    return Promise.resolve(undefined);
  });
});

/** Every `prefs|set_deliberate_folders` payload that reached `invoke`. */
function deliberateWrites(): Array<{ add?: string[]; remove?: string[] }> {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "plugin:prefs|set_deliberate_folders")
    .map(([, args]) => (args as { mutation: { add?: string[]; remove?: string[] } }).mutation);
}

/** Let the fire-and-forget registration settle before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("moveNoteToFolder folder registration (myne-md/myne#613)", () => {
  it("registers the destination as an ADD, claiming no removal", async () => {
    await moveNoteToFolder("id-1", "Projects/");
    await settle();
    const writes = deliberateWrites();
    expect(writes).toHaveLength(1); // floor: the call site fired at all
    expect(writes[0]?.add).toEqual(["Projects/"]);
    // A move can never claim a deletion, whatever the caller's view of the set
    // was. A `remove` here is the lost-update-becomes-distributed-delete defect.
    expect(writes[0]?.remove ?? []).toEqual([]);
  });

  it("registers the NORMALIZED path, which is what the note now carries", async () => {
    await moveNoteToFolder("id-1", "Projects/Myne"); // no trailing slash
    await settle();
    expect(deliberateWrites()[0]?.add).toEqual(["Projects/Myne/"]);
  });

  it("registers nothing for a move to the vault root", async () => {
    await moveNoteToFolder("id-1", null);
    await settle();
    // Leaving a folder is not deleting it, so the folder the note LEFT is
    // untouched too: no write of any kind.
    expect(deliberateWrites()).toEqual([]);
  });

  it("still writes the note itself when the registration fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:notes|note_read") return Promise.resolve("# Hello\n");
      if (cmd === "plugin:notes|note_update") return Promise.resolve(undefined);
      return Promise.reject(new Error("prefs write failed"));
    });
    await expect(moveNoteToFolder("id-1", "Projects/")).resolves.toBeUndefined();
    await settle();
    // The move is the user's actual request; remembering the folder is the
    // extra. A failed prefs write costs at most that the folder is not
    // remembered yet, and never the move.
    expect(invokeMock.mock.calls.filter(([c]) => c === "plugin:notes|note_update")).toHaveLength(1);
  });
});
