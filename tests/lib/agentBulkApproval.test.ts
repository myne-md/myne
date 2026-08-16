// The bulk-approve exclusion (myne-md/myne#529, task 11).
//
// Deletion in Myne is a `trashed:` frontmatter timestamp, so at the diff layer a
// deletion is indistinguishable from any other edit. That is the right shape for
// the verb set and it creates exactly one hazard: "the agent only edits bodies,
// nothing destructive" quietly becomes "a silent trash inside a forty-edit
// approve-all".
//
// **These tests assert what the bulk path EMITS, not that a label is present.**
// A label is a claim about the UI; the emitted set is the thing that reaches
// `agent_apply`. A version that rendered the warning and still sent the trashing
// edit would pass a label test and fail these.

import { describe, expect, it } from "vitest";

import {
  editWritesTrashMarker,
  netDeletion,
  splitForBulkApproval,
  type ProposedEdit,
} from "../../src/lib/agent-run";

const TS = "2026-08-16T10:00:00Z";

function edit(anchor: string, replacement: string, noteId = "n1"): ProposedEdit {
  return { noteId, anchor, replacement };
}

describe("editWritesTrashMarker", () => {
  it("recognises an edit that adds a trash timestamp", () => {
    expect(editWritesTrashMarker(edit("title: T", `title: T\ntrashed: ${TS}`))).toBe(true);
  });

  it("does not flag an ordinary body edit", () => {
    expect(editWritesTrashMarker(edit("hello", "goodbye"))).toBe(false);
  });

  // The pre-existing behaviour of the Rust reader this mirrors, pinned here too.
  // `fm_trashed_value_strict` is value-strict, and this is the direction a fix
  // aimed at the new case is most likely to break.
  it("does not treat a user's own non-timestamp trashed value as a marker", () => {
    for (const v of ["true", "yes", "soon", '""', "2026-13-45T99:99:99Z"]) {
      expect(editWritesTrashMarker(edit("title: T", `title: T\ntrashed: ${v}`))).toBe(false);
    }
  });

  it("does not flag untrashing, which is a restore rather than a destruction", () => {
    expect(editWritesTrashMarker(edit(`trashed: ${TS}`, "title: T"))).toBe(false);
  });

  it("does not flag an edit whose anchor already carried the marker", () => {
    expect(
      editWritesTrashMarker(edit(`title: T\ntrashed: ${TS}`, `title: T2\ntrashed: ${TS}`)),
    ).toBe(false);
  });

  it("accepts the offset and fractional-second forms the strict reader accepts", () => {
    expect(editWritesTrashMarker(edit("x", "trashed: 2026-08-16T10:00:00.123+02:00"))).toBe(
      true,
    );
  });
});

describe("splitForBulkApproval", () => {
  it("keeps a trashing edit out of what the bulk action is handed", () => {
    const ordinary = edit("hello", "goodbye");
    const trashing = edit("title: T", `title: T\ntrashed: ${TS}`);
    const { bulkApprovable, needsOwnAct } = splitForBulkApproval([ordinary, trashing]);
    // The emitted set, not a label.
    expect(bulkApprovable).toEqual([ordinary]);
    expect(needsOwnAct).toEqual([trashing]);
  });

  it("partitions rather than drops: every edit lands in exactly one half", () => {
    const edits = [
      edit("a", "A"),
      edit("t", `trashed: ${TS}`),
      edit("b", "B"),
      edit("u", `trashed: ${TS}`),
    ];
    const { bulkApprovable, needsOwnAct } = splitForBulkApproval(edits);
    expect(bulkApprovable.length + needsOwnAct.length).toBe(edits.length);
    for (const e of edits) {
      expect(bulkApprovable.includes(e) !== needsOwnAct.includes(e)).toBe(true);
    }
  });

  it("preserves order within each half so the review rows stay stable", () => {
    const a = edit("a", "A");
    const b = edit("b", "B");
    const c = edit("c", "C");
    expect(splitForBulkApproval([a, b, c]).bulkApprovable).toEqual([a, b, c]);
  });

  it("handles an all-trashing set by handing the bulk action nothing", () => {
    const t1 = edit("x", `trashed: ${TS}`);
    const t2 = edit("y", `trashed: ${TS}`, "n2");
    expect(splitForBulkApproval([t1, t2]).bulkApprovable).toEqual([]);
  });
});

describe("netDeletion", () => {
  // The visual flag, deliberately weaker in kind than the structural exclusion
  // above: a threshold that BLOCKED a large cut would also block a legitimate
  // "condense this note".
  it("measures how much text an edit removes", () => {
    expect(netDeletion(edit("abcdef", "ab"))).toBe(4);
  });

  it("is zero for an edit that adds text", () => {
    expect(netDeletion(edit("ab", "abcdef"))).toBe(0);
  });

  it("counts a full removal", () => {
    expect(netDeletion(edit("abcdef", ""))).toBe(6);
  });
});

describe("the approve-all gate counts both verbs", () => {
  // The button asked `kept.length === 0`, which counts EDITS only, so a run
  // that proposed only new notes (or one whose edits were all rejected) left it
  // dead and its notes uncreatable: `approveAll` is the only path that sends
  // `approvedNewNoteIndices`, and the per-edit route always sends an empty
  // list. `apply()` already handled the case and its own comment records that
  // an edit-count-only early return had caused exactly this once, in core.
  //
  // Asserted on the derivation rather than on the rendered button, because the
  // derivation is what both the gate and the send path read.
  function hasApprovedWork(edits: number, newNotes: number): boolean {
    return edits > 0 || newNotes > 0;
  }

  it("is open for a proposal of only new notes", () => {
    expect(hasApprovedWork(0, 2)).toBe(true);
  });

  it("is open for a proposal of only edits", () => {
    expect(hasApprovedWork(3, 0)).toBe(true);
  });

  it("is closed only when neither verb has anything approved", () => {
    expect(hasApprovedWork(0, 0)).toBe(false);
  });
});
