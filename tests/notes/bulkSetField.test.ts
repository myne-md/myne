// The bulk field set and its one-action restore (view-manifests task 10).
//
// The cases are the ones the acceptance names, because each is a place a plausible
// implementation is silently wrong:
//
//   1. a partial failure is reported PER NOTE with its own reason, and the count is
//      derived from the lists rather than tracked beside them;
//   2. one restore puts back every note the action wrote, in one call;
//   3. a note whose snapshot was coalesced away is reported as NOT restorable, not
//      skipped quietly;
//   4. the bulk path calls `note_set_field` and nothing else — no prefs write, no
//      direct file write — so the host keeps every authority check;
//   5. the journal is dropped on vault lock.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setNoteField = vi.hoisted(() => vi.fn());
const snapshotRestore = vi.hoisted(() => vi.fn());
const flush = vi.hoisted(() => vi.fn());

vi.mock("../../src/notes/setNoteField", () => ({
  NOTE_FIELD_WRITE_EVENT: "myne-note-field-written",
  setNoteField,
}));
vi.mock("../../src/notes/snapshots", () => ({ snapshotRestore }));
vi.mock("../../src/notes/flushBeforeFrontmatterWrite", () => ({
  flushBeforeFrontmatterWrite: () => flush(),
}));

import {
  bulkSetField,
  restoreLastBulkAction,
} from "../../src/notes/bulkSetField";
import {
  clearBulkUndoForLock,
  lastBulkAction,
} from "../../src/notes/views/bulkUndoJournal";

const REQUEST = {
  viewId: "v1",
  field: "status",
  newValue: "done",
  targets: [
    { noteId: "n1", expectedValue: null },
    { noteId: "n2", expectedValue: "todo" },
    { noteId: "n3", expectedValue: null },
  ],
};

beforeEach(() => {
  setNoteField.mockReset();
  snapshotRestore.mockReset().mockResolvedValue(undefined);
  flush.mockReset().mockResolvedValue(undefined);
  clearBulkUndoForLock();
});

afterEach(() => clearBulkUndoForLock());

describe("bulkSetField", () => {
  it("writes each note through note_set_field, one at a time", async () => {
    setNoteField
      .mockResolvedValueOnce({ snapshotId: "s1" })
      .mockResolvedValueOnce({ snapshotId: "s2" })
      .mockResolvedValueOnce({ snapshotId: "s3" });

    const result = await bulkSetField(REQUEST);

    expect(setNoteField).toHaveBeenCalledTimes(3);
    expect(setNoteField).toHaveBeenNthCalledWith(1, {
      noteId: "n1",
      viewId: "v1",
      field: "status",
      expectedValue: null,
      newValue: "done",
    });
    expect(result.writtenCount).toBe(3);
    expect(result.refusedCount).toBe(0);
    expect(result.actionId).not.toBeNull();
  });

  it("reports a partial failure per note with the host's own reason", async () => {
    setNoteField
      .mockResolvedValueOnce({ snapshotId: "s1" })
      .mockRejectedValueOnce({ kind: "FieldChanged" })
      .mockResolvedValueOnce({ snapshotId: "s3" });

    const result = await bulkSetField(REQUEST);

    expect(result.writtenCount).toBe(2);
    expect(result.written.map((w) => w.noteId)).toEqual(["n1", "n3"]);
    expect(result.refusedCount).toBe(1);
    expect(result.refused[0]).toEqual({
      noteId: "n2",
      reason: { kind: "FieldChanged" },
    });
    // Derived from the lists, not a parallel counter.
    expect(result.writtenCount).toBe(result.written.length);
    expect(result.refusedCount).toBe(result.refused.length);
  });

  it("does not record an action when nothing landed", async () => {
    setNoteField.mockRejectedValue({ kind: "NotApproved" });

    const result = await bulkSetField(REQUEST);

    expect(result.actionId).toBeNull();
    expect(lastBulkAction()).toBeNull();
  });

  it("records the snapshot ids so one restore can reach them", async () => {
    setNoteField
      .mockResolvedValueOnce({ snapshotId: "s1" })
      .mockResolvedValueOnce({ snapshotId: null })
      .mockResolvedValueOnce({ snapshotId: "s3" });

    await bulkSetField(REQUEST);

    expect(lastBulkAction()?.notes).toEqual([
      { noteId: "n1", snapshotId: "s1" },
      { noteId: "n2", snapshotId: null },
      { noteId: "n3", snapshotId: "s3" },
    ]);
  });
});

describe("restoreLastBulkAction", () => {
  it("restores every written note in one call, and says how many", async () => {
    setNoteField
      .mockResolvedValueOnce({ snapshotId: "s1" })
      .mockResolvedValueOnce({ snapshotId: "s2" })
      .mockResolvedValueOnce({ snapshotId: "s3" });
    await bulkSetField(REQUEST);

    const restored = await restoreLastBulkAction();

    expect(snapshotRestore).toHaveBeenCalledTimes(3);
    expect(restored.restoredCount).toBe(3);
    expect(restored.failed).toEqual([]);
    // One flush for the batch, not one per note.
    expect(flush).toHaveBeenCalledTimes(1);
    // Dropped once acted on: the button is not re-offered for the same action.
    expect(lastBulkAction()).toBeNull();
  });

  it("reports a coalesced-away note as NOT restorable rather than skipping it", async () => {
    setNoteField
      .mockResolvedValueOnce({ snapshotId: "s1" })
      .mockResolvedValueOnce({ snapshotId: null })
      .mockResolvedValueOnce({ snapshotId: "s3" });
    await bulkSetField(REQUEST);

    const restored = await restoreLastBulkAction();

    expect(restored.restoredCount).toBe(2);
    expect(restored.failed).toEqual([{ noteId: "n2", reason: "notRestorable" }]);
    // The restorable ones still went back: a partial restore is better than none,
    // and the report says exactly which is which.
    expect(snapshotRestore).toHaveBeenCalledWith("n1", "s1");
    expect(snapshotRestore).toHaveBeenCalledWith("n3", "s3");
  });

  it("reports a refused restore per note", async () => {
    setNoteField.mockResolvedValue({ snapshotId: "s1" });
    await bulkSetField({ ...REQUEST, targets: [REQUEST.targets[0]] });
    snapshotRestore.mockRejectedValueOnce({ kind: "SnapshotNotFound" });

    const restored = await restoreLastBulkAction();

    expect(restored.restoredCount).toBe(0);
    expect(restored.failed).toEqual([{ noteId: "n1", reason: "restoreFailed" }]);
  });

  it("does nothing when there is no action to restore", async () => {
    const restored = await restoreLastBulkAction();
    expect(restored.restoredCount).toBe(0);
    expect(snapshotRestore).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });
});

describe("the write path", () => {
  it("reaches no prefs binding and no raw invoke", () => {
    // The rule the acceptance states, made checkable: the bulk path's ONLY write
    // is `note_set_field`, so every authority check (approval, declaration, the
    // value-anchored precondition) happens in the host. A prefs write here would
    // be a second write path; a raw invoke would be a way around the wrapper.
    const source = readFileSync(
      fileURLToPath(new URL("../../src/notes/bulkSetField.ts", import.meta.url)),
      "utf8",
    );
    for (const forbidden of [
      "upsertSavedView",
      "setViewApproval",
      "writePref",
      'invoke(',
      "plugin:prefs|",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    // And the one it is allowed to call is there.
    expect(source).toContain("setNoteField");
  });
});

describe("the journal's lifetime", () => {
  it("is dropped on vault lock", async () => {
    setNoteField.mockResolvedValue({ snapshotId: "s1" });
    await bulkSetField(REQUEST);
    expect(lastBulkAction()).not.toBeNull();

    clearBulkUndoForLock();

    expect(lastBulkAction()).toBeNull();
    // And a restore afterwards has nothing to act on.
    const restored = await restoreLastBulkAction();
    expect(restored.restoredCount).toBe(0);
    expect(snapshotRestore).not.toHaveBeenCalled();
  });
});
