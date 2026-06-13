// Pre-flight open-dirty partition (MYND-85, WL-8 / SYNC-15).

import { describe, it, expect } from "vitest";
import { partitionInbound, type InboundNote } from "../../src/notes/renamePreflight";

const n = (noteId: string, isOpen: boolean, isDirty: boolean): InboundNote => ({
  noteId,
  isOpen,
  isDirty,
});

describe("partitionInbound (WL-8)", () => {
  it("open AND dirty → openDirty; everything else → closed", () => {
    const { closed, openDirty } = partitionInbound([
      n("a", false, false), // closed
      n("b", true, false), // open but clean → safe to disk-rewrite
      n("c", false, true), // dirty but not open → closed
      n("d", true, true), // open + dirty → must flush first
    ]);
    expect(closed.map((x) => x.noteId)).toEqual(["a", "b", "c"]);
    expect(openDirty.map((x) => x.noteId)).toEqual(["d"]);
  });

  it("empty input → empty buckets", () => {
    expect(partitionInbound([])).toEqual({ closed: [], openDirty: [] });
  });
});
