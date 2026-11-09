// An event is not a row in the notes tree (myne-md/myne#1037).
//
// An event is a NOTE on disk — that is what makes it encrypted, synced, backed up
// and exportable without a second store — but the notes UI must not show its
// markdown: the calendar is where an event is read and edited, and a tree full of
// `kind: event` documents beside real notes is the notes UI leaking an
// implementation detail (owner, 2026-11-08).
//
// TWO claims, and the second is the one that costs the feature if it is wrong:
//
// 1. `liveCache` — the sidebar's working-set projection — drops events; and
// 2. `isLiveNote`, the SHARED working-set predicate, still says yes for an event.
//    `core/src/plugins/vault_indices/calendar.rs` skips any record whose `live`
//    flag is false, so folding the exclusion into the predicate would empty the
//    calendar itself. A change that "tidies" the filter into `selectors.ts`
//    passes (1) and fails (2), which is why both are asserted here rather than
//    one in each file.

import { describe, expect, it } from "vitest";
import { isLiveNote } from "@myne/editor/host/notes/selectors";
import { liveCache } from "../../src/notes/sidebarState";
import type { TitleRecord } from "../../src/notes/loadNoteBatch";

function rec(over: Partial<TitleRecord> & { noteUuid: string }): TitleRecord {
  return {
    title: over.noteUuid,
    folder: null,
    updatedAt: null,
    trashed: null,
    deleted: null,
    archived: null,
    template: false,
    folderIndex: false,
    conflict: false,
    conflictOf: null,
    hasSource: false,
    kind: null,
    done: null,
    ...over,
  };
}

describe("liveCache — events are the calendar's, not the tree's", () => {
  it("drops an event and keeps an ordinary note beside it", () => {
    const cache = new Map(
      [
        rec({ noteUuid: "event-1", kind: "event" }),
        rec({ noteUuid: "note-1" }),
        rec({ noteUuid: "drawing-1", kind: "drawing" }),
      ].map((r) => [r.noteUuid, r] as const),
    );
    const live = liveCache(cache);
    expect([...live.keys()].sort()).toEqual(["drawing-1", "note-1"]);
  });

  it("still keeps events out when the vault also has an archived folder", () => {
    const cache = new Map(
      [
        rec({ noteUuid: "event-1", kind: "event", folder: "Archive/" }),
        rec({ noteUuid: "note-1", folder: "Projects/" }),
      ].map((r) => [r.noteUuid, r] as const),
    );
    expect([...liveCache(cache, ["Archive/"]).keys()]).toEqual(["note-1"]);
  });
});

describe("isLiveNote — an event is still IN the working set", () => {
  it("answers yes, because the calendar's range read requires it", () => {
    // The assertion is the predicate's, not this file's: `calendar.rs` refuses a
    // record whose `live` is false, and `vaultIndices` derives that flag from
    // this function.
    expect(isLiveNote({ kind: "event", trashed: null })).toBe(true);
  });
});
