// Mobile's note-selection predicates are the SHARED ones (#46 / #260).
//
// They used to be re-implemented here and as `useMemo`s in `EditorFlow`, and
// the two clients' answers to "is this note in the working set" drifted
// independently. `98acbcc9` added the tombstone filter to desktop's Trash list;
// mobile's never got it, so "Delete permanently" was a visible no-op (the
// tombstone it writes left the row rendered) and "Discard" never cleared a
// conflict (same shape, in the Conflicts sheet).
//
// These assert the axes mobile was missing, through the module mobile imports.

import { describe, expect, it } from "vitest";
import {
  isArchivedNote,
  isListedTemplate,
  isLiveNote,
  isResolverCandidate,
  isTrashedNote,
} from "../src/lib/note-organize";

const T = "2026-08-03T10:00:00Z";

describe("mobile note selection", () => {
  it("keeps a tombstone out of the Trash list", () => {
    // The defect: "Delete permanently" writes `deleted:` and leaves `trashed:`,
    // so a list filtering on `trashed != null` alone re-renders the row.
    expect(isTrashedNote({ trashed: T, deleted: null })).toBe(true);
    expect(isTrashedNote({ trashed: T, deleted: T })).toBe(false);
  });

  it("keeps a tombstone out of the Archive list", () => {
    expect(isArchivedNote({ archived: T, trashed: null, deleted: null })).toBe(true);
    expect(isArchivedNote({ archived: T, deleted: T })).toBe(false);
  });

  it("keeps a tombstoned template out of the Templates sheet", () => {
    expect(isListedTemplate({ template: true })).toBe(true);
    expect(isListedTemplate({ template: true, deleted: T })).toBe(false);
    expect(isListedTemplate({ template: true, trashed: T })).toBe(false);
  });

  it("still separates the working set from the resolver set", () => {
    // The one axis that must NOT be collapsed: an archived note is out of the
    // list but remains a valid wikilink target.
    expect(isLiveNote({ archived: T })).toBe(false);
    expect(isResolverCandidate({ archived: T })).toBe(true);
  });
});
