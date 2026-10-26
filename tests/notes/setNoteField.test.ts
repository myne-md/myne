// @vitest-environment jsdom
//
// Unit tests for `src/notes/setNoteField.ts` (view-manifests task 5).
//
// The host decides everything that matters (approval, declaration, the
// value-anchored precondition), so what this layer owes is the three things a
// WebView caller does around an out-of-band write, and they are what is pinned
// here:
//
//   1. the flush finishes BEFORE the command is invoked,
//   2. a success re-indexes the note and announces the write so panes re-read,
//   3. a refusal announces nothing (no bytes changed, so no pane is stale) and
//      leaves the named reason intact for the caller.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const flushMock = vi.fn();
const reindexMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("../../src/notes/flushBeforeFrontmatterWrite", () => ({
  flushBeforeFrontmatterWrite: () => flushMock(),
}));

vi.mock("../../src/notes/vaultIndices", () => ({
  reindexNoteFromBody: (...args: unknown[]) => reindexMock(...args),
}));

import {
  NOTE_FIELD_WRITE_EVENT,
  setNoteField,
} from "../../src/notes/setNoteField";
import type { NoteFieldWriteDetail } from "../../src/notes/setNoteField";

const NOTE_ID = "0190a000-0000-7000-8000-00000000000b";
const VIEW_ID = "0190a000-0000-7000-8000-0000000000aa";

beforeEach(() => {
  invokeMock.mockReset();
  flushMock.mockReset();
  flushMock.mockResolvedValue(undefined);
  reindexMock.mockReset();
  reindexMock.mockResolvedValue(undefined);
});

afterEach(() => {
  invokeMock.mockReset();
  flushMock.mockReset();
  reindexMock.mockReset();
});

function route(handler: (cmd: string) => unknown): void {
  invokeMock.mockImplementation((cmd: string) => handler(cmd));
}

describe("setNoteField", () => {
  it("flushes every dirty pane BEFORE the command runs", async () => {
    const order: string[] = [];
    flushMock.mockImplementation(() => {
      order.push("flush");
      return Promise.resolve();
    });
    route((cmd) => {
      if (cmd === "plugin:notes|note_set_field") {
        order.push("invoke");
        return Promise.resolve("snap-1");
      }
      if (cmd === "plugin:notes|note_read") return Promise.resolve("body");
      throw new Error(`unexpected command ${cmd}`);
    });

    await setNoteField({
      noteId: NOTE_ID,
      viewId: VIEW_ID,
      field: "status",
      expectedValue: "reading",
      newValue: "done",
    });

    expect(order[0]).toBe("flush");
    expect(order[1]).toBe("invoke");
  });

  it("sends the field write with the caller's expected value and returns the snapshot id", async () => {
    route((cmd) => {
      if (cmd === "plugin:notes|note_set_field") return Promise.resolve("snap-42");
      if (cmd === "plugin:notes|note_read") return Promise.resolve("new body");
      throw new Error(`unexpected command ${cmd}`);
    });

    const result = await setNoteField({
      noteId: NOTE_ID,
      viewId: VIEW_ID,
      field: "status",
      expectedValue: "reading",
      newValue: "done",
    });

    expect(result).toEqual({ snapshotId: "snap-42" });
    const call = invokeMock.mock.calls.find(
      ([cmd]) => cmd === "plugin:notes|note_set_field",
    );
    expect(call?.[1]).toEqual({
      noteId: NOTE_ID,
      viewId: VIEW_ID,
      field: "status",
      expectedValue: "reading",
      newValue: "done",
    });
  });

  it("sends a null expected value for a field the caller believes is absent", async () => {
    route((cmd) => {
      if (cmd === "plugin:notes|note_set_field") return Promise.resolve(null);
      if (cmd === "plugin:notes|note_read") return Promise.resolve("body");
      throw new Error(`unexpected command ${cmd}`);
    });

    await setNoteField({
      noteId: NOTE_ID,
      viewId: VIEW_ID,
      field: "status",
      expectedValue: null,
      newValue: "done",
    });

    const call = invokeMock.mock.calls.find(
      ([cmd]) => cmd === "plugin:notes|note_set_field",
    );
    expect((call?.[1] as { expectedValue: unknown }).expectedValue).toBeNull();
  });

  it("re-indexes the note from the bytes now on disk and announces the write", async () => {
    route((cmd) => {
      if (cmd === "plugin:notes|note_set_field") return Promise.resolve(null);
      if (cmd === "plugin:notes|note_read") return Promise.resolve("---\nstatus: done\n---\n");
      throw new Error(`unexpected command ${cmd}`);
    });

    const seen: string[] = [];
    const listener = (e: Event): void => {
      seen.push((e as CustomEvent<NoteFieldWriteDetail>).detail.noteId);
    };
    window.addEventListener(NOTE_FIELD_WRITE_EVENT, listener);
    try {
      await setNoteField({
        noteId: NOTE_ID,
        viewId: VIEW_ID,
        field: "status",
        expectedValue: null,
        newValue: "done",
      });
    } finally {
      window.removeEventListener(NOTE_FIELD_WRITE_EVENT, listener);
    }

    expect(reindexMock).toHaveBeenCalledWith(
      NOTE_ID,
      "---\nstatus: done\n---\n",
    );
    expect(seen).toEqual([NOTE_ID]);
  });

  it("propagates a refusal unchanged and announces nothing", async () => {
    route((cmd) => {
      if (cmd === "plugin:notes|note_set_field") {
        return Promise.reject({ kind: "FieldChanged" });
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const seen: string[] = [];
    const listener = (e: Event): void => {
      seen.push((e as CustomEvent<NoteFieldWriteDetail>).detail.noteId);
    };
    window.addEventListener(NOTE_FIELD_WRITE_EVENT, listener);
    try {
      await expect(
        setNoteField({
          noteId: NOTE_ID,
          viewId: VIEW_ID,
          field: "status",
          expectedValue: "reading",
          newValue: "done",
        }),
      ).rejects.toEqual({ kind: "FieldChanged" });
    } finally {
      window.removeEventListener(NOTE_FIELD_WRITE_EVENT, listener);
    }

    expect(seen).toEqual([]);
    expect(reindexMock).not.toHaveBeenCalled();
  });

  it("does not invoke the command when the flush fails", async () => {
    flushMock.mockRejectedValue(new Error("unsaved pane could not be saved"));

    await expect(
      setNoteField({
        noteId: NOTE_ID,
        viewId: VIEW_ID,
        field: "status",
        expectedValue: null,
        newValue: "done",
      }),
    ).rejects.toThrow("unsaved pane");

    expect(invokeMock).not.toHaveBeenCalled();
    expect(reindexMock).not.toHaveBeenCalled();
  });
});
