// The `[[` picker's recency order (myne-md/myne#601), producer side.
//
// `tests/editor/wikilink-picker-recency.test.ts` covers the CONSUMER: it hands
// `rankNotes` a recency array written by hand and checks the ordering. That
// leaves the thing that builds the array untested, and its logic is not
// nothing: a move-to-head dedupe, a cap, and an idempotence guard that skips the
// work when the note is already at the head. Emptying `noteBecameActive`'s body
// used to fail nothing while the whole feature stopped recording.

import { beforeEach, describe, expect, it } from "vitest";
import {
  noteBecameActive,
  recentNoteIds,
  resetRecentNotes,
} from "../../src/notes/recentNotes";

beforeEach(() => {
  resetRecentNotes();
});

describe("recentNoteIds", () => {
  it("starts empty", () => {
    expect(recentNoteIds()).toEqual([]);
  });

  it("puts the most recently activated note first", () => {
    noteBecameActive("a");
    noteBecameActive("b");
    noteBecameActive("c");
    expect(recentNoteIds()).toEqual(["c", "b", "a"]);
  });

  it("moves a note already in the list to the head rather than duplicating it", () => {
    noteBecameActive("a");
    noteBecameActive("b");
    noteBecameActive("a");
    expect(recentNoteIds()).toEqual(["a", "b"]);
  });

  it("is a no-op when the note is already at the head", () => {
    // The identity of the returned array is the contract `recentNoteIds`'s own
    // doc states, because a consumer uses it as a render key: a re-activation
    // that changes nothing must not look like a change.
    noteBecameActive("a");
    const before = recentNoteIds();
    noteBecameActive("a");
    expect(recentNoteIds()).toBe(before);
  });

  it("returns a NEW array reference when the order did change", () => {
    // The other direction of the same contract. Without this the idempotence
    // guard above could be satisfied by never rebuilding at all.
    noteBecameActive("a");
    const before = recentNoteIds();
    noteBecameActive("b");
    expect(recentNoteIds()).not.toBe(before);
  });

  it("caps the list, keeping the most recent", () => {
    // The cap is what stops a long session turning the picker's tiebreak into an
    // unbounded array. Asserted against the module's own limit by activating
    // well past it rather than by importing the constant, so a changed cap shows
    // up here as a changed number rather than as a test that moves with it.
    for (let i = 0; i < 80; i += 1) noteBecameActive(`n${i}`);
    const ids = recentNoteIds();
    expect(ids.length).toBeLessThanOrEqual(50);
    expect(ids[0]).toBe("n79");
    expect(ids).not.toContain("n0");
  });

  it("forgets everything on reset, which is what a vault-leaving path calls", () => {
    noteBecameActive("a");
    resetRecentNotes();
    expect(recentNoteIds()).toEqual([]);
  });
});
