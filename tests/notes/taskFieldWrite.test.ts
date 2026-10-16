// @vitest-environment jsdom
//
// The task FIELD mutation, view-free (myne-md/myne#884 task 7).
//
// `toggleTask.test.ts` is the sibling for the marker flip, and this file is the
// same shape for the second mutation: one field on one line, from a surface with
// no editor in it.
//
// # Why byte-equivalence is the acceptance criterion rather than a nicety
//
// A task list that can edit fields and a note that can edit fields are two
// writers for one line, and a line with two writers drifts: the list would emit
// a form the editor would not, or would reorder the fields, or would fold a
// space the editor keeps, and the user would see their note change shape
// depending on which surface they happened to use. So the two must agree
// BYTE FOR BYTE, and the assertion here drives the editor's own
// `applyTaskFieldEdit` through a real CodeMirror dispatch rather than restating
// what it is believed to do. Restating it would make this a test of a
// transcription.
//
// Everything else in the file is the sequence's own safety: a stale raw line, an
// over-cap record, a line that has gone, and a sync pull-apply that raced the
// write each refuse rather than guessing.

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { applyTaskFieldEdit } from "@myne/editor/decorations/task-chip";
import {
  rewriteTaskField,
  writeTaskField,
  TaskWriteRefused,
  type TaskFieldKind,
  type TaskFieldWriteIo,
} from "../../src/notes/taskWriteCore";
import { sha256Hex } from "../../src/notes/baseHash";
import type { VaultTask } from "../../src/notes/taskIndex";

const LINE = "- [ ] pay the rent [due:: 2026-08-01]";
const NOTE = `---\ntitle: Bills\n---\n\n${LINE}\n\nsome prose\n`;

function lineTask(over: Partial<VaultTask> = {}): VaultTask {
  return {
    noteId: "n1",
    noteTitle: "Bills",
    noteFolder: null,
    lineIndex: 4,
    rawLine: LINE,
    completed: false,
    oversized: false,
    ...over,
  } as VaultTask;
}

function deps(over: Partial<TaskFieldWriteIo> = {}) {
  const written: Array<{ body: string; hash: string }> = [];
  const d: TaskFieldWriteIo = {
    readNote: async () => NOTE,
    writeNote: async (_id, body, hash) => {
      written.push({ body, hash });
    },
    announce: () => {},
    createConflictCopy: async () => "copy-1",
    ...over,
  };
  return { d, written };
}

/**
 * The editor's own span-based field write, through the dispatch a real gesture
 * produces: a fresh view over the line, the edit, and the document that results.
 */
function editorWrite(line: string, kind: TaskFieldKind, value: string): string {
  const view = new EditorView({ state: EditorState.create({ doc: line }) });
  try {
    applyTaskFieldEdit(view, { from: 0, to: 0, kind }, value);
    return view.state.doc.toString();
  } finally {
    view.destroy();
  }
}

/**
 * The inputs the equivalence is claimed over. Chosen for the shapes that could
 * plausibly diverge, not for breadth: setting a field the line lacks, changing
 * and clearing one it has, a value the instant parser refuses, recovering from a
 * malformed one, a field Myne carries without interpreting, an indented line,
 * and a description whose own trailing space sits against the field block.
 */
const EQUIVALENCE: ReadonlyArray<{
  readonly name: string;
  readonly line: string;
  readonly kind: TaskFieldKind;
  readonly value: string;
}> = [
  { name: "adds a due date to a line that has none", line: "- [ ] water plants", kind: "due", value: "2026-09-01" },
  { name: "changes an existing due date", line: LINE, kind: "due", value: "2026-09-01" },
  { name: "clears an existing due date", line: LINE, kind: "due", value: "" },
  { name: "adds a time to a date", line: LINE, kind: "due", value: "2026-09-01T09:30" },
  { name: "keeps a value the instant parser refuses", line: LINE, kind: "due", value: "not-a-date" },
  { name: "recovers a previously malformed value", line: "- [ ] rent [due:: not-a-date]", kind: "due", value: "2026-09-01" },
  { name: "sets a reminder", line: LINE, kind: "remind", value: "2026-08-31" },
  { name: "sets priority", line: LINE, kind: "priority", value: "high" },
  { name: "changes priority", line: "- [ ] rent [priority:: high]", kind: "priority", value: "low" },
  { name: "clears priority", line: "- [ ] rent [priority:: high]", kind: "priority", value: "" },
  { name: "sets a repeat rule", line: LINE, kind: "repeat", value: "every weekday" },
  { name: "clears a repeat rule", line: "- [ ] rent [repeat:: weekly]", kind: "repeat", value: "" },
  { name: "leaves an uninterpreted field alone beside the edit", line: "- [ ] rent [onCompletion:: delete]", kind: "priority", value: "high" },
  { name: "keeps the description's own trailing space before the block", line: "- [ ] rent  [priority:: high]", kind: "due", value: "2026-09-01" },
  { name: "rewrites an indented task", line: "  - [ ] nested [due:: 2026-08-01]", kind: "priority", value: "high" },
  { name: "rewrites a starred marker", line: "* [ ] starred", kind: "due", value: "2026-09-01" },
];

describe("the field rewrite is the editor's own write, byte for byte", () => {
  it.each(EQUIVALENCE)("$name", ({ line, kind, value }) => {
    expect(rewriteTaskField(line, kind, value)).toBe(editorWrite(line, kind, value));
  });

  it("the table is not vacuous: most of it really rewrites the line", () => {
    // Without this the whole block passes if BOTH sides return the input
    // unchanged, which is exactly what a rewrite that never fires looks like.
    const changed = EQUIVALENCE.filter(
      ({ line, kind, value }) => rewriteTaskField(line, kind, value) !== line,
    );
    expect(changed.length).toBeGreaterThan(8);
  });

  it("both sides agree on doing NOTHING, which is the other half of agreeing", () => {
    // A no-op cannot sit in the table above, because the two halves spell it
    // differently: the view-free rewrite answers `null` (its "nothing to
    // change") while the editor answers with a document it never touched. That
    // difference is why this is a case of its own rather than a row.
    expect(rewriteTaskField(LINE, "due", "2026-08-01")).toBeNull();
    expect(editorWrite(LINE, "due", "2026-08-01")).toBe(LINE);
  });

  it("returns null when the line already reads exactly as the write would", () => {
    // `null` is the writer's "nothing to change", and the sequence below turns it
    // into no write at all. A rewrite that returned the input instead would make
    // every no-op write the whole note.
    const same = "- [ ] rent [priority:: high]";
    expect(rewriteTaskField(same, "priority", "high")).toBeNull();
  });
});

describe("the write sequence", () => {
  it("writes the note with the field applied, surrounding bytes untouched", async () => {
    const { d, written } = deps();
    await writeTaskField(lineTask(), "due", "2026-09-01", d);
    expect(written).toHaveLength(1);
    expect(written[0]!.body).toContain("- [ ] pay the rent [due:: 2026-09-01]");
    expect(written[0]!.body).toContain("title: Bills");
    expect(written[0]!.body).toContain("some prose");
  });

  it("writes with the content hash of what it READ, not of what it writes", async () => {
    // The cross-note compare-and-swap: the backend rejects the write if the note
    // on disk is no longer what this sequence read.
    const { d, written } = deps();
    await writeTaskField(lineTask(), "priority", "high", d);
    expect(written[0]!.hash).toBe(await sha256Hex(NOTE));
  });

  it("flushes dirty panes BEFORE reading", async () => {
    const order: string[] = [];
    const { d } = deps({
      flushDirtyPanes: async () => void order.push("flush"),
      readNote: async () => {
        order.push("read");
        return NOTE;
      },
    });
    await writeTaskField(lineTask(), "priority", "high", d);
    expect(order).toEqual(["flush", "read"]);
  });

  it("announces AFTER the write, so an open pane reloads once the bytes land", async () => {
    const order: string[] = [];
    const { d } = deps({
      writeNote: async () => void order.push("write"),
      announce: () => void order.push("announce"),
    });
    await writeTaskField(lineTask(), "priority", "high", d);
    expect(order).toEqual(["write", "announce"]);
  });

  it("tolerates a CRLF note without calling it a stale line", async () => {
    const { d, written } = deps({ readNote: async () => NOTE.split("\n").join("\r\n") });
    await writeTaskField(lineTask(), "priority", "high", d);
    expect(written).toHaveLength(1);
  });
});

describe("refusals are explainable, never guesses", () => {
  it("refuses an over-cap record, naming the reason, with no write at all", async () => {
    const { d, written } = deps();
    await expect(
      writeTaskField(lineTask({ oversized: true }), "due", "2026-09-01", d),
    ).rejects.toMatchObject({ reason: "oversized" });
    expect(written).toHaveLength(0);
  });

  it("refuses a stale stored line: no write, no snapshot, no index touch", async () => {
    // The index is a cache and can be an autosave behind. Patching by line number
    // alone would rewrite whatever is on that line now.
    const { d, written } = deps({
      readNote: async () => NOTE.replace(LINE, "- [ ] something else entirely"),
    });
    await expect(
      writeTaskField(lineTask(), "due", "2026-09-01", d),
    ).rejects.toMatchObject({ reason: "line-changed" });
    expect(written).toHaveLength(0);
  });

  it("refuses a line that has gone", async () => {
    const { d } = deps({ readNote: async () => "---\ntitle: Bills\n---\n" });
    await expect(writeTaskField(lineTask(), "due", "2026-09-01", d)).rejects.toMatchObject({
      reason: "line-missing",
    });
  });

  it("refuses a line that is no longer a task line", async () => {
    const task = lineTask({ rawLine: "plain prose now" });
    const { d } = deps({ readNote: async () => `${"\n".repeat(4)}plain prose now\n` });
    await expect(writeTaskField(task, "due", "2026-09-01", d)).rejects.toMatchObject({
      reason: "line-changed",
    });
  });

  it("refuses a note-task, which has no line to rewrite", async () => {
    // The completion path patches the frontmatter for a note-task; a FIELD lives
    // on a line, so there is nothing here to write. Refusing is the honest
    // answer, and the locator is the discriminator in both mutations.
    const { d, written } = deps();
    await expect(
      writeTaskField(lineTask({ lineIndex: null, rawLine: "" }), "due", "2026-09-01", d),
    ).rejects.toMatchObject({ reason: "line-missing" });
    expect(written).toHaveLength(0);
  });

  it("writes nothing, and refuses nothing, when the value is already there", async () => {
    const { d, written } = deps();
    await writeTaskField(lineTask(), "due", "2026-08-01", d);
    expect(written).toHaveLength(0);
  });
});

describe("cross-note compare-and-swap", () => {
  const baseMismatch = { kind: "BaseMismatch" as const };

  it("a sync race is rejected by the content hash, not clobbered", async () => {
    const { d } = deps({
      writeNote: async () => {
        throw baseMismatch;
      },
      createConflictCopy: async () => "copy-1",
    });
    await expect(writeTaskField(lineTask(), "due", "2026-09-01", d)).rejects.toMatchObject({
      reason: "base-mismatch",
    });
  });

  it("the refusal preserves the body as a keep-both copy", async () => {
    const copies: Array<{ body: string; original: string }> = [];
    const { d } = deps({
      writeNote: async () => {
        throw baseMismatch;
      },
      createConflictCopy: async (body, original) => {
        copies.push({ body, original });
        return "copy-1";
      },
    });
    await writeTaskField(lineTask(), "due", "2026-09-01", d).catch(() => {});
    expect(copies).toHaveLength(1);
    // The copy carries what THIS write would have produced; what sync delivered
    // stays on disk untouched.
    expect(copies[0]!.body).toContain("[due:: 2026-09-01]");
    expect(copies[0]!.original).toBe("n1");
  });

  it("does not announce a reload after a refused write", async () => {
    const announced: string[] = [];
    const { d } = deps({
      writeNote: async () => {
        throw baseMismatch;
      },
      createConflictCopy: async () => "copy-1",
      announce: (id) => void announced.push(id),
    });
    await writeTaskField(lineTask(), "due", "2026-09-01", d).catch(() => {});
    expect(announced).toHaveLength(0);
  });

  it("propagates a non-mismatch IPC error unchanged", async () => {
    const copies: unknown[] = [];
    const { d } = deps({
      writeNote: async () => {
        throw new Error("disk on fire");
      },
      createConflictCopy: async () => {
        copies.push(1);
        return "copy-1";
      },
    });
    await expect(writeTaskField(lineTask(), "due", "2026-09-01", d)).rejects.toThrow(
      "disk on fire",
    );
    expect(copies).toHaveLength(0);
  });

  it("the refusal is a TaskWriteRefused, not a bare Error", async () => {
    // A caller distinguishes "explain this to the user" from "the write failed"
    // by the class, so the sibling's own class is reused rather than a second.
    const { d } = deps({
      writeNote: async () => {
        throw baseMismatch;
      },
      createConflictCopy: async () => "copy-1",
    });
    await expect(writeTaskField(lineTask(), "due", "2026-09-01", d)).rejects.toBeInstanceOf(
      TaskWriteRefused,
    );
  });
});
