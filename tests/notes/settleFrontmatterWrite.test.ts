// The settle half of the out-of-band-frontmatter-write bug class.
//
// `flushBeforeFrontmatterWrite` runs before the write so the disk matches the
// buffer; this runs after it so the buffer matches the disk. It is three lines,
// and the reason it has a test is the reason it has a module: it used to be a
// closure in `Editor.tsx` whose comment said the recipe belongs to the bug
// class, and a third caller in another file then hand-copied the two lines. A
// recipe that can be forgotten, silently, needs both halves pinned.

import { describe, expect, it, vi } from "vitest";
import { settleFrontmatterWrite } from "../../src/notes/settleFrontmatterWrite";
import type { NoteId } from "../../src/notes/sidebarState";

const ID = "note-1" as NoteId;

describe("settleFrontmatterWrite", () => {
  it("re-reads the open note AND the record", () => {
    const sidebar = { reloadOpenNote: vi.fn(), refreshOne: vi.fn().mockResolvedValue(undefined) };
    void settleFrontmatterWrite(sidebar, ID);
    expect(sidebar.reloadOpenNote).toHaveBeenCalledTimes(1);
    expect(sidebar.refreshOne).toHaveBeenCalledWith(ID);
  });

  it("reloads the buffer BEFORE awaiting the record refresh", async () => {
    // Order, not merely both. The reload is what stops the pane's next autosave
    // writing the pre-write frontmatter back; the record refresh only settles
    // the tree. A version that awaited the refresh first would leave the revert
    // window open for the length of an IPC round trip.
    const order: string[] = [];
    let release = (): void => {};
    const pending = new Promise<void>((r) => {
      release = r;
    });
    const sidebar = {
      reloadOpenNote: vi.fn(() => {
        order.push("reload");
      }),
      refreshOne: vi.fn(() => {
        order.push("refresh");
        return pending;
      }),
    };
    const settled = settleFrontmatterWrite(sidebar, ID);
    expect(order).toEqual(["reload", "refresh"]);
    release();
    await settled;
  });

  it("propagates a failing record refresh rather than swallowing it", () => {
    // The caller decides what a failed settle means. Swallowing here would make
    // "the tree did not update" indistinguishable from "it did".
    const sidebar = {
      reloadOpenNote: vi.fn(),
      refreshOne: vi.fn().mockRejectedValue(new Error("refresh failed")),
    };
    return expect(settleFrontmatterWrite(sidebar, ID)).rejects.toThrow("refresh failed");
  });
});
