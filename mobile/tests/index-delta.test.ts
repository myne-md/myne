// The delta tracker that keeps both index feeds proportional to the edit
// (myne-mobile#41). These assertions are about the CONTRACT the two EditorFlow
// effects lean on — that `diff` is pure, that an unaccepted item comes back, and
// that a dropped id is reported exactly once. Get any of them wrong and the
// symptom is silent: either the index quietly goes stale, or the whole-vault
// sweep the fix removed comes back without anything failing.

import { describe, it, expect } from "vitest";
import { createIndexDeltaTracker, type DeltaItem } from "../src/lib/index-delta";

const note = (id: string, body: string, title = id, folder: string | null = null): DeltaItem => ({
  id,
  title,
  folder,
  body,
});

/** Accept everything a diff reported — what a fully-successful sweep does. */
function accept(
  tracker: ReturnType<typeof createIndexDeltaTracker>,
  delta: { changed: DeltaItem[]; removed: string[] },
): void {
  delta.changed.forEach((i) => tracker.markApplied(i));
  delta.removed.forEach((id) => tracker.markRemoved(id));
}

describe("createIndexDeltaTracker", () => {
  it("reports the whole corpus on the first pass, then nothing", () => {
    const tracker = createIndexDeltaTracker();
    const corpus = [note("a", "alpha"), note("b", "beta")];

    const first = tracker.diff(corpus);
    expect(first.changed.map((i) => i.id)).toEqual(["a", "b"]);
    expect(first.removed).toEqual([]);
    accept(tracker, first);

    // The identical corpus a second time — this is the case that used to
    // re-send every note, because `bodies` is a fresh Map on every load.
    expect(tracker.diff(corpus).changed).toEqual([]);
  });

  it("reports only the note whose body changed", () => {
    const tracker = createIndexDeltaTracker();
    accept(tracker, tracker.diff([note("a", "alpha"), note("b", "beta")]));

    const delta = tracker.diff([note("a", "alpha"), note("b", "beta — edited")]);
    expect(delta.changed.map((i) => i.id)).toEqual(["b"]);
    expect(delta.removed).toEqual([]);
  });

  it("treats a title or folder move as a change even when the body is untouched", () => {
    const tracker = createIndexDeltaTracker();
    // Both feed the record: `titleKey` is the backlink join key and `folder` is
    // stored on it, so a rename with an identical body must still re-apply.
    accept(tracker, tracker.diff([note("a", "same body", "Eski")]));
    expect(tracker.diff([note("a", "same body", "Yeni")]).changed.map((i) => i.id)).toEqual(["a"]);

    const moved = createIndexDeltaTracker();
    accept(moved, moved.diff([note("a", "same body", "Ev", null)]));
    expect(moved.diff([note("a", "same body", "Ev", "Arşiv")]).changed.map((i) => i.id)).toEqual([
      "a",
    ]);
  });

  it("reports an id that left the corpus, once", () => {
    const tracker = createIndexDeltaTracker();
    accept(tracker, tracker.diff([note("a", "alpha"), note("b", "beta")]));

    const delta = tracker.diff([note("a", "alpha")]);
    expect(delta.changed).toEqual([]);
    expect(delta.removed).toEqual(["b"]);
    accept(tracker, delta);

    // Already dropped — a second sweep must not ask the backend to remove it
    // again (that is the loop that would never settle).
    expect(tracker.diff([note("a", "alpha")]).removed).toEqual([]);
  });

  it("keeps reporting an item whose apply was never accepted", () => {
    const tracker = createIndexDeltaTracker();
    const corpus = [note("a", "alpha"), note("b", "beta")];

    // A sweep cancelled after the first note: only `a` was accepted.
    const first = tracker.diff(corpus);
    tracker.markApplied(first.changed[0]!);

    expect(tracker.diff(corpus).changed.map((i) => i.id)).toEqual(["b"]);
  });

  it("does not record anything from diff alone", () => {
    const tracker = createIndexDeltaTracker();
    const corpus = [note("a", "alpha")];

    tracker.diff(corpus);
    tracker.diff(corpus);
    expect(tracker.isEmpty()).toBe(true);
    expect(tracker.diff(corpus).changed.map((i) => i.id)).toEqual(["a"]);
  });

  it("reports empty until the first accepted item, and again after reset", () => {
    const tracker = createIndexDeltaTracker();
    expect(tracker.isEmpty()).toBe(true);

    accept(tracker, tracker.diff([note("a", "alpha")]));
    expect(tracker.isEmpty()).toBe(false);

    // Vault switch: the backend index is gone, so the next pass must re-seed
    // the whole corpus rather than a delta against a vault that is no longer open.
    tracker.reset();
    expect(tracker.isEmpty()).toBe(true);
    expect(tracker.diff([note("a", "alpha")]).changed.map((i) => i.id)).toEqual(["a"]);
  });

  it("carries the caller's own item fields through the diff untouched", () => {
    const tracker = createIndexDeltaTracker();
    const enriched = { ...note("a", "alpha"), folderIndex: false as const };

    const [changed] = tracker.diff([enriched]).changed;
    expect(changed).toBe(enriched);
  });
});
