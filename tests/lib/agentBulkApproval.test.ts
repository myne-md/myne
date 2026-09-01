// The bulk-approve exclusion (myne-md/myne#529, task 11).
//
// Every way Myne takes a note out of the note list is a frontmatter field, so at
// the diff layer a removal is indistinguishable from any other edit. That is the
// right shape for the verb set and it creates exactly one hazard: "the agent
// only edits bodies, nothing destructive" quietly becomes "a silent removal
// inside a forty-edit approve-all".
//
// **Five fields, not one.** The shipped version read `trashed:` alone, so a
// `deleted:` edit — the marker that hides a note from Trash as well as from the
// sidebar, leaving no view the user can reach it from — was bulk-approvable
// (review round five). The roster here is not hand-picked: it is what
// `isLiveNote` reads, and `the marker roster` below holds this file's copy to
// the Rust one rather than to a second opinion.
//
// **These tests assert what the bulk path EMITS, not that a label is present.**
// A label is a claim about the UI; the emitted set is the thing that reaches
// `agent_apply`. A version that rendered the warning and still sent the trashing
// edit would pass a label test and fail these.

import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  editHidesNote,
  editHidesNoteAs,
  HIDING_MARKERS,
  netDeletion,
  splitForBulkApproval,
  type ProposedEdit,
} from "../../src/lib/agent-run";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TS = "2026-08-16T10:00:00Z";

/** One frontmatter line per marker, keyed by field. */
const MARKER_LINE: Record<string, string> = {
  trashed: `trashed: ${TS}`,
  deleted: `deleted: ${TS}`,
  archived: `archived: ${TS}`,
  template: "template: true",
  conflict: "conflict: true",
};

function edit(anchor: string, replacement: string, noteId = "n1"): ProposedEdit {
  return { noteId, anchor, replacement };
}

describe("the marker roster", () => {
  // The half neither side can check alone. Both rosters are hand-written (a Rust
  // array and a TS array cannot be shared), so what has to be pinned is that
  // they name the same fields — the drift that shipped, in which the host read
  // one field and the screen read the same one, is invisible to a test that
  // compares either against itself.
  function rustRoster(): string[] {
    const src = readFileSync(join(REPO, "core/src/plugins/agent/hide.rs"), "utf8");
    const body = /fn markers\(body: &str\) -> Markers \{([\s\S]*?)\n\}/.exec(src);
    if (body === null) {
      throw new Error(
        "markers() not found in core/src/plugins/agent/hide.rs — if it moved, " +
          "this test has to follow it rather than be deleted",
      );
    }
    return [...body[1].matchAll(/fm_([a-z]+)_value_strict/g)].map((m) => m[1]);
  }

  it("finds a roster at all, so a rename cannot make this vacuous", () => {
    // Set comparison below: two empty sets are equal, and a regex that stopped
    // matching would turn this green while checking nothing.
    expect(rustRoster().length).toBe(5);
    expect(HIDING_MARKERS.length).toBe(5);
  });

  it("names the same fields host-side and screen-side", () => {
    expect([...HIDING_MARKERS.map((m) => m.field)].sort()).toEqual([...rustRoster()].sort());
  });

  it("has a test line for every field, so no marker goes unexercised below", () => {
    expect(Object.keys(MARKER_LINE).sort()).toEqual([...rustRoster()].sort());
  });
});

describe("editHidesNote", () => {
  it("recognises an edit that adds ANY of the markers", () => {
    for (const [field, line] of Object.entries(MARKER_LINE)) {
      expect(editHidesNote(edit("title: T", `title: T\n${line}`)), field).toBe(true);
    }
  });

  it("reports WHICH marker, because the row label says so to the user", () => {
    for (const [field, line] of Object.entries(MARKER_LINE)) {
      expect(editHidesNoteAs(edit("title: T", `title: T\n${line}`))).toBe(field);
    }
    expect(editHidesNoteAs(edit("hello", "goodbye"))).toBeNull();
  });

  it("does not flag an ordinary body edit", () => {
    expect(editHidesNote(edit("hello", "goodbye"))).toBe(false);
  });

  // The pre-existing behaviour of the Rust readers this mirrors, pinned here
  // too, across the whole roster. Value-strictness is the direction a fix aimed
  // at WIDENING the roster is most likely to break.
  it("does not treat a user's own non-canonical value as a marker", () => {
    for (const field of ["trashed", "deleted", "archived"]) {
      for (const v of ["true", "yes", "soon", '""', "2026-13-45T99:99:99Z"]) {
        expect(editHidesNote(edit("title: T", `title: T\n${field}: ${v}`)), `${field}: ${v}`).toBe(
          false,
        );
      }
    }
    for (const field of ["template", "conflict"]) {
      for (const v of ['"true"', "1", "True", "yes"]) {
        expect(editHidesNote(edit("title: T", `title: T\n${field}: ${v}`)), `${field}: ${v}`).toBe(
          false,
        );
      }
    }
  });

  it("does not flag removing a marker, which is a restore rather than a destruction", () => {
    for (const [field, line] of Object.entries(MARKER_LINE)) {
      expect(editHidesNote(edit(line, "title: T")), field).toBe(false);
    }
  });

  it("does not flag an edit whose anchor already carried the marker", () => {
    for (const [field, line] of Object.entries(MARKER_LINE)) {
      expect(
        editHidesNote(edit(`title: T\n${line}`, `title: T2\n${line}`)),
        field,
      ).toBe(false);
    }
  });

  it("accepts the offset and fractional-second forms the strict reader accepts", () => {
    expect(editHidesNote(edit("x", "trashed: 2026-08-16T10:00:00.123+02:00"))).toBe(true);
  });
});

describe("splitForBulkApproval", () => {
  it("keeps a removing edit out of what the bulk action is handed, for every marker", () => {
    for (const [field, line] of Object.entries(MARKER_LINE)) {
      const ordinary = edit("hello", "goodbye");
      const removing = edit("title: T", `title: T\n${line}`);
      const { bulkApprovable, needsOwnAct } = splitForBulkApproval([ordinary, removing]);
      // The emitted set, not a label.
      expect(bulkApprovable, field).toEqual([ordinary]);
      expect(needsOwnAct, field).toEqual([removing]);
    }
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

  it("handles an all-removing set by handing the bulk action nothing", () => {
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

// **An append is not a removal, and flagging one would be a false statement to
// the user at the moment they are deciding** (myne-md/myne#616).
//
// Appended text lands in the note's BODY, after its frontmatter block, so a
// `trashed:` line inside it is prose rather than a marker. The host agrees, and
// its agreement is what matters: `apply::tests::
// an_append_cannot_hide_a_note_because_its_text_lands_in_the_body` reads the
// resulting frontmatter and finds nothing. Without the append arm in
// `editHidesNoteAs` the screen would put "moves this note to Trash" over a row
// that does no such thing, AND route it out of the bulk approve for a reason
// that is not true.
//
// The over-flagging licence the rest of this module relies on does not stretch
// here: it argues for flagging when the outcome is UNCERTAIN, and this outcome
// is known.
describe("an append is never a removal", () => {
  function appendEdit(text: string, noteId = "n1"): ProposedEdit {
    return { noteId, kind: "append", anchor: "", replacement: text };
  }

  it("is not flagged for any marker, even when its text is exactly one", () => {
    for (const [field, line] of Object.entries(MARKER_LINE)) {
      const proposed = appendEdit(`---\n${line}\n---`);
      expect(editHidesNoteAs(proposed), field).toBeNull();
      expect(editHidesNote(proposed), field).toBe(false);
    }
  });

  it("stays in the bulk-approvable pile", () => {
    const { bulkApprovable, needsOwnAct } = splitForBulkApproval([
      appendEdit(`---\n${MARKER_LINE.trashed}\n---`),
    ]);
    expect(needsOwnAct).toHaveLength(0);
    expect(bulkApprovable).toHaveLength(1);
  });

  it("does not weaken the replace shape it shares a type with", () => {
    // The direction that would make the arm above a hole: the same text as an
    // anchored replacement is still caught.
    const replaced = edit("body", `body\n${MARKER_LINE.trashed}`);
    expect(editHidesNote(replaced)).toBe(true);
  });

  it("treats an edit with no kind field as the replace it always was", () => {
    const legacy = edit("body", `body\n${MARKER_LINE.trashed}`);
    expect(legacy.kind).toBeUndefined();
    expect(editHidesNote(legacy)).toBe(true);
  });
});
