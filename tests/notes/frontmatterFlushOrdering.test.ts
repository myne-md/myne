// Every out-of-band frontmatter writer flushes dirty panes BEFORE it reads
// (myne-md/myne#520).
//
// This property is invisible everywhere else. A writer with the flush missing,
// or with the flush fired and not awaited, type-checks, passes every guard in
// `scripts/`, and fails only against a real dirty buffer and a real 1 s autosave
// debounce, which is precisely the state no unit test of a screen is ever in.
//
// The three writers are asserted TOGETHER, in one table, because the failure the
// issue records is not "one writer forgot" but "the recipe forked": the cover
// write got the flush and the template convert, the same read-patch-write shape
// one function away, did not. A per-writer test would have been green for the
// forked half too.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("../../src/notes/vaultIndices", () => ({
  reindexNoteFromBody: () => Promise.resolve(),
}));

import {
  clearRenameFlushHooks,
  registerRenameFlushHooks,
} from "../../src/notes/renameFlushHook";
import { setNoteCover } from "../../src/notes/setNoteCover";
import { restoreNote, trashNote } from "../../src/notes/trashNote";
import { archiveNote, unarchiveNote } from "../../src/notes/archiveNote";
import { deleteNoteRouted } from "../../src/notes/deleteNote";
import {
  convertNoteToTemplate,
  convertTemplateToNote,
} from "../../src/notes/templates";

/** A note with frontmatter, so every writer under test has something to patch
 *  and none of them short-circuits on a no-op. */
const BODY = "---\ntitle: Foo\ncover: \"![[att:old|old.png]]\"\ntemplate: true\n---\n\nbody\n";

/** The steps, in the order they happened. */
let order: string[] = [];
/** Set once the flush has resolved, read by the `note_read` route. */
let flushed = false;

beforeEach(() => {
  order = [];
  flushed = false;
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "plugin:notes|note_read") {
      order.push(flushed ? "read-after-flush" : "read-before-flush");
      return Promise.resolve(BODY);
    }
    if (cmd === "plugin:notes|note_update") {
      order.push("write");
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
});

/** Register a flush that resolves LATE. Resolving on a later microtask is what
 *  separates "awaited" from "fired": an unawaited flush produces the same call
 *  ORDER and still races, so the read records whether the flush had finished
 *  rather than merely whether it had started. */
function registerLateFlush(): void {
  registerRenameFlushHooks({
    openNoteIds: () => new Set<string>(),
    flushOpenPanes: () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          order.push("flush");
          flushed = true;
          resolve();
        }, 0),
      ),
  });
}

/**
 * Register a flush that always fails.
 *
 * This is the shape `workspaceContext`'s `flushAll` produces when a pane does
 * not settle, which is the case that matters: `useAutosave.fireSave` swallows
 * its own rejection into that pane's `saveStatus`, so a failed `note_update`
 * resolves the flush exactly like a successful one and the only signal is the
 * buffer still being dirty afterwards. An earlier version of this file injected
 * a rejecting `flushOpenPanes` while production could not produce one, which is
 * a guard verified against a shape the tree does not have.
 */
function registerFailingFlush(): void {
  registerRenameFlushHooks({
    openNoteIds: () => new Set<string>(),
    flushOpenPanes: () => Promise.reject(new Error("flush boom")),
  });
}

const WRITERS: ReadonlyArray<{ name: string; run: (id: string) => Promise<void> }> = [
  {
    name: "setNoteCover",
    run: (id) => setNoteCover(id, "cover", { id: "new", filename: "new.png" }),
  },
  { name: "convertNoteToTemplate", run: convertNoteToTemplate },
  { name: "convertTemplateToNote", run: convertTemplateToNote },
  // The trash/restore/delete family (myne-md/myne#819): their losing direction
  // is a resurrected note, not a reverted field, so they joined the roster.
  { name: "trashNote", run: trashNote },
  { name: "restoreNote", run: restoreNote },
  // The archive pair (myne-md/myne#825): #825 closes the archived note's tabs,
  // so a dirty pane's autosave-on-unmount is a second writer that would silently
  // un-archive. Same losing direction, same flush.
  { name: "archiveNote", run: archiveNote },
  { name: "unarchiveNote", run: unarchiveNote },
  // `forceTombstone` keeps the routed delete on the frontmatter path the mock
  // can drive, instead of probing for a sync endpoint.
  { name: "deleteNoteRouted", run: (id) => deleteNoteRouted(id, true) },
];

describe.each(WRITERS)("$name flushes before it writes", (w) => {
  it("waits for the flush to resolve before reading the note", async () => {
    registerLateFlush();
    try {
      await w.run("note-1");
    } finally {
      clearRenameFlushHooks();
    }
    expect(order[0]).toBe("flush");
    expect(order[1]).toBe("read-after-flush");
    expect(order).toContain("write");
  });

  it("aborts without reading or writing when the flush fails", async () => {
    // The flush exists to make the disk match the buffer. Carrying on after it
    // failed is the clobber it was added to prevent, so a rejection has to stop
    // the sequence rather than be logged past.
    registerFailingFlush();
    try {
      await expect(w.run("note-1")).rejects.toThrow("flush boom");
    } finally {
      clearRenameFlushHooks();
    }
    expect(order).toEqual([]);
  });
});

describe("with no workspace mounted", () => {
  it("still writes, because the default flush is a no-op", async () => {
    // A rename composed before the workspace mounts, and every unit test in the
    // tree, hits the `EMPTY` hooks. A writer that hung or threw there would take
    // the whole suite with it.
    clearRenameFlushHooks();
    await setNoteCover("note-1", "cover", null);
    expect(order).toContain("write");
  });
});
