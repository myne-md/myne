// myne#217: the content comparison behind `useLiveResolverNotes`'s reference
// stability.
//
// This predicate decides two things at once, and they pull in opposite
// directions: return `true` too eagerly and a pane's wikilink chips stop
// re-resolving when a note appears or is renamed (the "linked but looks broken
// on reload" bug the old `liveNotes.slice()` existed to prevent); return `false`
// too eagerly and every index-change nonce invalidates the pane's memos and
// dispatches a facet reconfigure into the editor the user is typing in.
//
// So every field the resolver actually reads gets a case here — a field added to
// `ResolverNote` without a line in the comparator would silently take the first
// failure mode.

import { describe, expect, it } from "vitest";

import { sameResolverNotes } from "../../src/notes/resolverNotes";
import type { ResolverNote } from "../../src/notes/resolveWikilink";

function note(p: Partial<ResolverNote> & { noteUuid: string }): ResolverNote {
  return {
    noteUuid: p.noteUuid,
    title: p.title ?? "A note",
    folder: p.folder ?? null,
    folderIndex: p.folderIndex ?? false,
    isDrawing: p.isDrawing ?? false,
  };
}

describe("sameResolverNotes", () => {
  it("is true for the identical reference", () => {
    const a = [note({ noteUuid: "n1" })];
    expect(sameResolverNotes(a, a)).toBe(true);
  });

  it("is true for two distinct arrays with equal content", () => {
    // The case that matters: a re-derived projection of an unchanged cache.
    const a = [note({ noteUuid: "n1" }), note({ noteUuid: "n2", title: "Other" })];
    const b = [note({ noteUuid: "n1" }), note({ noteUuid: "n2", title: "Other" })];
    expect(sameResolverNotes(a, b)).toBe(true);
  });

  it("is false when a note appears or disappears", () => {
    const one = [note({ noteUuid: "n1" })];
    const two = [note({ noteUuid: "n1" }), note({ noteUuid: "n2" })];
    expect(sameResolverNotes(one, two)).toBe(false);
    expect(sameResolverNotes(two, one)).toBe(false);
  });

  it("is false when a title changes — the rename case chips must re-resolve on", () => {
    const before = [note({ noteUuid: "n1", title: "Old name" })];
    const after = [note({ noteUuid: "n1", title: "New name" })];
    expect(sameResolverNotes(before, after)).toBe(false);
  });

  it("is false when a title becomes null, and when it stops being null", () => {
    const titled = [note({ noteUuid: "n1", title: "Named" })];
    const untitled = [note({ noteUuid: "n1", title: null })];
    expect(sameResolverNotes(titled, untitled)).toBe(false);
    expect(sameResolverNotes(untitled, titled)).toBe(false);
  });

  it("is false when a folder changes — path-form links resolve through it", () => {
    const root = [note({ noteUuid: "n1", folder: null })];
    const filed = [note({ noteUuid: "n1", folder: "Work/" })];
    expect(sameResolverNotes(root, filed)).toBe(false);
  });

  it("is false when folderIndex flips — folder-target links resolve through it", () => {
    const plain = [note({ noteUuid: "n1", folderIndex: false })];
    const index = [note({ noteUuid: "n1", folderIndex: true })];
    expect(sameResolverNotes(plain, index)).toBe(false);
  });

  it("is false when isDrawing flips — the embed picks a different widget", () => {
    const text = [note({ noteUuid: "n1", isDrawing: false })];
    const drawing = [note({ noteUuid: "n1", isDrawing: true })];
    expect(sameResolverNotes(text, drawing)).toBe(false);
  });

  it("is false when the same notes arrive in a different order", () => {
    // Order is the projection's, and a reordering changes what the array says;
    // treating it as equal would be a judgement call this layer should not make.
    const forward = [note({ noteUuid: "n1" }), note({ noteUuid: "n2" })];
    const reversed = [note({ noteUuid: "n2" }), note({ noteUuid: "n1" })];
    expect(sameResolverNotes(forward, reversed)).toBe(false);
  });

  it("handles the empty set in both directions", () => {
    expect(sameResolverNotes([], [])).toBe(true);
    expect(sameResolverNotes([], [note({ noteUuid: "n1" })])).toBe(false);
    expect(sameResolverNotes([note({ noteUuid: "n1" })], [])).toBe(false);
  });
});
