// The shared note-selection predicates (#260).
//
// These decide which notes reach the shared engines, and until now each client
// re-implemented them: desktop inline in `sidebarState`, mobile as `useMemo`s
// in `EditorFlow`. Four defects lived in that gap. The tests pin the axes that
// differ between predicates, because that is where a re-implementation drifts —
// notably that an ARCHIVED note is not in the working set but IS still a
// wikilink target, and that a tombstone is in no view at all.

import { describe, expect, it } from "vitest";
import {
  isArchivedNote,
  isConflictCopy,
  isListedTemplate,
  isLiveNote,
  isResolverCandidate,
  isTemplateNote,
  isTombstoned,
  isTrashedNote,
  type NoteFlags,
} from "@myne/editor/host/notes/selectors";

const T = "2026-08-03T10:00:00Z";
const plain: NoteFlags = {};

describe("isLiveNote", () => {
  it("accepts a note with no markers", () => {
    expect(isLiveNote(plain)).toBe(true);
  });

  it("rejects every non-working-set axis", () => {
    expect(isLiveNote({ trashed: T })).toBe(false);
    expect(isLiveNote({ deleted: T })).toBe(false);
    expect(isLiveNote({ archived: T })).toBe(false);
    expect(isLiveNote({ template: true })).toBe(false);
    expect(isLiveNote({ conflict: true })).toBe(false);
  });

  it("treats a missing field as not-marked", () => {
    // Defensive direction: a record built without `trashed` is live, never
    // "unknown, so hide it".
    expect(isLiveNote({ trashed: undefined, deleted: undefined })).toBe(true);
  });
});

describe("isResolverCandidate", () => {
  it("is wider than isLiveNote by exactly the archive axis", () => {
    // Archive is a working-set filter, not a deletion — an archived note stays
    // a valid wikilink / backlink / graph target. This is the one axis that
    // stops the two predicates from being collapsed into one.
    const archived: NoteFlags = { archived: T };
    expect(isLiveNote(archived)).toBe(false);
    expect(isResolverCandidate(archived)).toBe(true);
  });

  it("still rejects trash, tombstones, templates and conflict copies", () => {
    expect(isResolverCandidate({ trashed: T })).toBe(false);
    expect(isResolverCandidate({ deleted: T })).toBe(false);
    expect(isResolverCandidate({ template: true })).toBe(false);
    expect(isResolverCandidate({ conflict: true })).toBe(false);
  });
});

describe("isTrashedNote", () => {
  it("is the Trash panel's view", () => {
    expect(isTrashedNote({ trashed: T })).toBe(true);
    expect(isTrashedNote(plain)).toBe(false);
  });

  it("excludes a tombstone that is also trashed", () => {
    // The defect mobile shipped: "Delete permanently" writes the tombstone, and
    // a Trash list that ignores `deleted:` keeps rendering the row — so the
    // action looks like a no-op.
    expect(isTrashedNote({ trashed: T, deleted: T })).toBe(false);
  });
});

describe("the remaining single-axis predicates", () => {
  it("name exactly one condition each", () => {
    expect(isTombstoned({ deleted: T })).toBe(true);
    expect(isTombstoned(plain)).toBe(false);
    expect(isConflictCopy({ conflict: true })).toBe(true);
    expect(isConflictCopy(plain)).toBe(false);
    expect(isTemplateNote({ template: true })).toBe(true);
    expect(isArchivedNote({ archived: T })).toBe(true);
    // Archive and trash are disjoint rafts; a trashed record is not archived.
    expect(isArchivedNote({ archived: T, trashed: T })).toBe(false);
  });

  it("lists a template only while it is neither trashed nor tombstoned", () => {
    expect(isListedTemplate({ template: true })).toBe(true);
    expect(isListedTemplate({ template: true, trashed: T })).toBe(false);
    expect(isListedTemplate({ template: true, deleted: T })).toBe(false);
  });
});
