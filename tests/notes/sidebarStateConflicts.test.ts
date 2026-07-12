// Pure-helper tests for the MYND-427 conflict surface in
// `src/notes/sidebarState.tsx`. The React Context provider is exercised at
// integration time (`Editor.tsx` mount); these tests cover the conflict-copy
// grouping / count helpers (`conflictRecordsByOriginal`, `conflictCount`) and
// the conflict-exclusion predicates added to `liveCache` + `resolverCache`
// (a `conflict: true` keep-both copy stays OUT of the live sidebar AND out of
// the backlink/graph resolver until reconciled) — without a React renderer.
//
// Companion to `sidebarState.test.ts`; mirrors its record-fixture +
// cache-construction shape (a `Map<NoteId, TitleRecord>`-backed builder).

import { describe, expect, it } from "vitest";
import {
  conflictRecordsByOriginal,
  liveCache,
  resolverCache,
} from "../../src/notes/sidebarState";
import type { TitleRecord } from "../../src/notes/loadNoteBatch";

/**
 * Build a `Map<NoteId, TitleRecord>` cache from compact tuples. Extends the
 * sibling `sidebarState.test.ts` `stateWith` fixture shape with the two MYND-427
 * conflict fields (`conflict`, `conflictOf`); every other marker defaults to
 * "live" (`null` / `false`) so a record is only excluded for the reason under
 * test.
 */
function cacheWith(
  entries: Array<
    [id: string, conflict: boolean, conflictOf: string | null, deleted?: string | null]
  >,
): Map<string, TitleRecord> {
  const cache = new Map<string, TitleRecord>();
  for (const [id, conflict, conflictOf, deleted] of entries) {
    cache.set(id, {
      noteUuid: id,
      title: conflict ? `${id} (conflict)` : id,
      folder: null,
      updatedAt: null,
      trashed: null,
      deleted: deleted ?? null,
      archived: null,
      template: false,
      folderIndex: false,
      conflict,
      conflictOf,
    });
  }
  return cache;
}

// A mixed set: two live notes, three conflict copies forked from two distinct
// originals (orig-a ×2, orig-b ×1) plus one conflict copy with no `conflictOf`
// (the null → "(unknown)" fallback bucket).
function mixedCache(): Map<string, TitleRecord> {
  return cacheWith([
    ["live-1", false, null],
    ["live-2", false, null],
    ["conf-a1", true, "orig-a"],
    ["conf-a2", true, "orig-a"],
    ["conf-b1", true, "orig-b"],
    ["conf-orphan", true, null],
  ]);
}

// NOTE: the `conflictCount` selector was retired (MYND-461) — the engine now
// produces `Conflicts{count}` core-side (`sync_status`), so the WebView no longer
// counts conflict copies from its title cache. Its tests moved with it.

describe("conflictRecordsByOriginal", () => {
  it("groups conflict copies by conflictOf, including the null fallback bucket", () => {
    const groups = conflictRecordsByOriginal(mixedCache());

    // Three buckets: orig-a, orig-b, and the "(unknown)" null fallback.
    expect(groups.size).toBe(3);

    expect(groups.get("orig-a")?.map((r) => r.noteUuid)).toEqual([
      "conf-a1",
      "conf-a2",
    ]);
    expect(groups.get("orig-b")?.map((r) => r.noteUuid)).toEqual(["conf-b1"]);

    // `conflictOf: null` lands in the "(unknown)" bucket.
    expect(groups.get("(unknown)")?.map((r) => r.noteUuid)).toEqual([
      "conf-orphan",
    ]);
  });

  it("excludes live (conflict:false) records from every bucket", () => {
    const groups = conflictRecordsByOriginal(mixedCache());
    const grouped = [...groups.values()].flat().map((r) => r.noteUuid);
    expect(grouped).not.toContain("live-1");
    expect(grouped).not.toContain("live-2");
    // Total grouped == total conflict copies.
    expect(grouped).toHaveLength(4);
  });

  it("returns an empty Map when there are no conflict copies", () => {
    const cache = cacheWith([["live-1", false, null]]);
    expect(conflictRecordsByOriginal(cache).size).toBe(0);
  });

  // Discard fix: hitting "Discard" routes the conflict copy through the
  // propagating `deleted:` tombstone. The copy keeps its `conflict:` marker on
  // disk (until horizon-GC) but must DROP OUT of the Conflicts list immediately
  // — otherwise discard looks like it does nothing.
  it("excludes a deleted (discarded) conflict copy from the groups", () => {
    const cache = cacheWith([
      ["conf-a1", true, "orig-a"],
      ["conf-a2", true, "orig-a", "2026-06-29T00:00:00Z"], // discarded → tombstoned
    ]);
    const groups = conflictRecordsByOriginal(cache);
    const ids = (groups.get("orig-a") ?? []).map((r) => r.noteUuid);
    expect(ids).toEqual(["conf-a1"]); // the discarded copy is gone
  });
});

describe("liveCache conflict exclusion (MYND-427)", () => {
  it("keeps conflict:true copies OUT of the live sidebar", () => {
    const live = liveCache(mixedCache());
    // Only the two live notes survive.
    expect([...live.keys()].sort()).toEqual(["live-1", "live-2"]);
    expect(live.has("conf-a1")).toBe(false);
    expect(live.has("conf-orphan")).toBe(false);
  });
});

describe("resolverCache conflict exclusion (MYND-427)", () => {
  it("keeps conflict:true copies OUT of the backlink/graph resolver", () => {
    const resolver = resolverCache(mixedCache());
    expect([...resolver.keys()].sort()).toEqual(["live-1", "live-2"]);
    expect(resolver.has("conf-b1")).toBe(false);
    expect(resolver.has("conf-orphan")).toBe(false);
  });
});
