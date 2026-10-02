// @vitest-environment jsdom
//
// The single task-mutation writer (MYND-616 task 8).
//
// Every seam is injected, so the tests exercise the ORDER of operations — which
// is where this function's correctness lives. Three of them would each corrupt
// or lose user work if got wrong: flushing after the read patches a stale body,
// patching without verifying the raw line ticks whatever is on that line now,
// and writing without the content hash clobbers a sync pull that raced it.

import { describe, expect, it, vi } from "vitest";
import {
  flipMarker,
  setTaskCompleted,
  TASK_WRITE_EVENT,
  TaskWriteRefused,
  toggleTask,
  type TaskWriteDeps,
} from "../../src/notes/toggleTask";
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

function deps(over: Partial<TaskWriteDeps> = {}) {
  const written: Array<{ body: string; hash: string }> = [];
  const d: TaskWriteDeps = {
    readNote: async () => NOTE,
    writeNote: async (_id, body, hash) => {
      written.push({ body, hash });
    },
    completeNoteTask: async () => {},
    uncompleteNoteTask: async () => {},
    announce: () => {},
    ...over,
  };
  return { d, written };
}

describe("flipMarker", () => {
  it("ticks and un-ticks, preserving the rest of the line byte-for-byte", () => {
    expect(flipMarker(LINE, true)).toBe("- [x] pay the rent [due:: 2026-08-01]");
    expect(flipMarker("- [x] done thing", false)).toBe("- [ ] done thing");
  });

  it("un-ticks an uppercase marker", () => {
    expect(flipMarker("- [X] shouty", false)).toBe("- [ ] shouty");
  });

  it("leaves a line already in the requested state byte-identical", () => {
    // The comparison is on the marker's MEANING, not on the rendered string, so
    // re-asserting "completed" on an imported `[X]` must not rewrite it to
    // `[x]` — that would be a §6 C1 normalization this layer does not perform,
    // and `TaskRecord`'s doc promises the uppercase marker survives untouched.
    expect(flipMarker("- [X] shouty", true)).toBe("- [X] shouty");
    expect(flipMarker("- [x] done thing", true)).toBe("- [x] done thing");
    expect(flipMarker("- [ ] open thing", false)).toBe("- [ ] open thing");
  });

  it("preserves indentation and the list bullet", () => {
    expect(flipMarker("  * [ ] nested", true)).toBe("  * [x] nested");
    expect(flipMarker("\t+ [ ] tabbed", true)).toBe("\t+ [x] tabbed");
  });

  it("returns null for a line that is not a task", () => {
    expect(flipMarker("just prose", true)).toBeNull();
    expect(flipMarker("- a plain list item", true)).toBeNull();
  });
});

describe("one function, both kinds of task", () => {
  it("patches the line for a line-task", async () => {
    const { d, written } = deps();
    await setTaskCompleted(lineTask(), true, d);
    expect(written).toHaveLength(1);
    expect(written[0]!.body).toContain("- [x] pay the rent [due:: 2026-08-01]");
    // Surrounding bytes untouched.
    expect(written[0]!.body).toContain("title: Bills");
    expect(written[0]!.body).toContain("some prose");
  });

  it("patches the frontmatter field for a note-task", async () => {
    // The locator IS the discriminator: absent means the whole note is the task.
    const completeNoteTask = vi.fn(async () => {});
    const { d, written } = deps({ completeNoteTask });
    await setTaskCompleted(lineTask({ lineIndex: null, rawLine: "" }), true, d);
    expect(completeNoteTask).toHaveBeenCalledWith("n1");
    expect(written).toHaveLength(0); // no line surgery for a note-task
  });

  it("un-completes a note-task through the inverse", async () => {
    const uncompleteNoteTask = vi.fn(async () => {});
    const { d } = deps({ uncompleteNoteTask });
    await setTaskCompleted(
      lineTask({ lineIndex: null, rawLine: "", completed: true }),
      false,
      d,
    );
    expect(uncompleteNoteTask).toHaveBeenCalledWith("n1");
  });

  it("toggleTask flips whatever the record reports", async () => {
    const { d, written } = deps();
    await toggleTask(lineTask({ completed: false }), d);
    expect(written[0]!.body).toContain("- [x]");
  });
});

describe("order of operations", () => {
  it("flushes dirty panes BEFORE reading", async () => {
    // Reading first would patch a body older than what the user can see, and
    // the flush would then overwrite the patch.
    const order: string[] = [];
    const { d } = deps({
      flushDirtyPanes: async () => void order.push("flush"),
      readNote: async () => {
        order.push("read");
        return NOTE;
      },
    });
    await setTaskCompleted(lineTask(), true, d);
    expect(order).toEqual(["flush", "read"]);
  });

  it("flushes even for a note-task", async () => {
    const flushDirtyPanes = vi.fn(async () => {});
    const { d } = deps({ flushDirtyPanes });
    await setTaskCompleted(lineTask({ lineIndex: null, rawLine: "" }), true, d);
    expect(flushDirtyPanes).toHaveBeenCalled();
  });

  it("saves with the content hash of what it read", async () => {
    const { d, written } = deps();
    await setTaskCompleted(lineTask(), true, d);
    expect(written[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("announces afterwards so an open pane reloads", async () => {
    const seen: string[] = [];
    const onWrite = (e: Event) => seen.push((e as CustomEvent<{ noteId: string }>).detail.noteId);
    window.addEventListener(TASK_WRITE_EVENT, onWrite);
    const { d } = deps({ announce: undefined });
    await setTaskCompleted(lineTask(), true, d);
    window.removeEventListener(TASK_WRITE_EVENT, onWrite);
    expect(seen).toEqual(["n1"]);
  });

  it("announces AFTER the write, not before", async () => {
    const order: string[] = [];
    const { d } = deps({
      writeNote: async () => void order.push("write"),
      announce: () => void order.push("announce"),
    });
    await setTaskCompleted(lineTask(), true, d);
    expect(order).toEqual(["write", "announce"]);
  });
});

describe("refusals are explainable, never guesses", () => {
  it("refuses an oversized record and says why", async () => {
    const { d, written } = deps();
    await expect(setTaskCompleted(lineTask({ oversized: true }), true, d)).rejects.toThrow(
      TaskWriteRefused,
    );
    expect(written).toHaveLength(0);
  });

  it("names the oversized reason so a surface can explain it", async () => {
    const { d } = deps();
    // `rejects.toMatchObject` rather than a `.catch()`: if a future
    // implementation resolved instead of throwing, the catch would never run
    // and the reason assertion would never be consulted.
    await expect(setTaskCompleted(lineTask({ oversized: true }), true, d)).rejects.toMatchObject({
      reason: "oversized",
    });
  });

  it("refuses when the stored raw line no longer matches the note", async () => {
    // The index is a cache and can be an autosave behind. Patching by line
    // number alone would tick whatever is on that line NOW.
    const { d, written } = deps({
      readNote: async () => NOTE.replace(LINE, "- [ ] something else entirely"),
    });
    await expect(setTaskCompleted(lineTask(), true, d)).rejects.toMatchObject({
      reason: "line-changed",
    });
    expect(written).toHaveLength(0);
  });

  it("refuses when the line is gone entirely", async () => {
    const { d } = deps({ readNote: async () => "---\ntitle: Bills\n---\n" });
    await expect(setTaskCompleted(lineTask(), true, d)).rejects.toMatchObject({
      reason: "line-missing",
    });
  });

  it("refuses when the line is no longer a task line", async () => {
    const task = lineTask({ rawLine: "plain prose now" });
    const { d } = deps({ readNote: async () => `${"\n".repeat(4)}plain prose now\n` });
    await expect(setTaskCompleted(task, true, d)).rejects.toMatchObject({
      reason: "line-changed",
    });
  });

  it("tolerates a CRLF note without calling it a mismatch", async () => {
    // The index stores the line without its terminator; a CRLF file would
    // otherwise fail verification on every single task.
    const { d, written } = deps({ readNote: async () => NOTE.split("\n").join("\r\n") });
    await setTaskCompleted(lineTask(), true, d);
    expect(written).toHaveLength(1);
  });
});

describe("no-ops", () => {
  it("writes nothing when the task is already in the requested state", async () => {
    const { d, written } = deps({
      readNote: async () => NOTE.replace(LINE, "- [x] pay the rent [due:: 2026-08-01]"),
    });
    await setTaskCompleted(
      lineTask({ rawLine: "- [x] pay the rent [due:: 2026-08-01]", completed: true }),
      true,
      d,
    );
    expect(written).toHaveLength(0);
  });
});

describe("cross-note compare-and-swap (MYND-617 task 7)", () => {
  const baseMismatch = { kind: "BaseMismatch" as const };

  it("passes the expected content hash on EVERY write", async () => {
    // Every other cross-note writer omits it — but those patch idempotent
    // frontmatter fields, and a body-line checkbox flip is not idempotent-safe.
    const { d, written } = deps();
    await setTaskCompleted(lineTask(), true, d);
    expect(written[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    // The hash is of what was READ, not of what is being written.
    const { sha256Hex } = await import("../../src/notes/baseHash");
    expect(written[0]!.hash).toBe(await sha256Hex(NOTE));
  });

  it("refuses on a mismatched hash with no write", async () => {
    const { d } = deps({
      writeNote: async () => {
        throw baseMismatch;
      },
      createConflictCopy: async () => "copy-1",
    });
    await expect(setTaskCompleted(lineTask(), true, d)).rejects.toMatchObject({
      reason: "base-mismatch",
    });
  });

  it("the refusal path produces a keep-both copy, not an overwrite", async () => {
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
    await setTaskCompleted(lineTask(), true, d).catch(() => {});
    expect(copies).toHaveLength(1);
    // The copy carries the body the tick WOULD have written; what sync
    // delivered stays on disk untouched.
    expect(copies[0]!.body).toContain("- [x] pay the rent");
    expect(copies[0]!.original).toBe("n1");
  });

  it("does not announce a reload after a refused write", async () => {
    // Announcing would make every open pane re-read for a write that never
    // happened.
    const announced: string[] = [];
    const { d } = deps({
      writeNote: async () => {
        throw baseMismatch;
      },
      createConflictCopy: async () => "copy-1",
      announce: (id) => void announced.push(id),
    });
    await setTaskCompleted(lineTask(), true, d).catch(() => {});
    expect(announced).toHaveLength(0);
  });

  it("propagates a non-mismatch IPC error unchanged", async () => {
    // Only a base mismatch means keep-both. A disk error is a real failure and
    // must not be dressed up as a conflict.
    const boom = new Error("disk on fire");
    const copies: unknown[] = [];
    const { d } = deps({
      writeNote: async () => {
        throw boom;
      },
      createConflictCopy: async () => {
        copies.push(1);
        return "copy-1";
      },
    });
    await expect(setTaskCompleted(lineTask(), true, d)).rejects.toThrow("disk on fire");
    expect(copies).toHaveLength(0);
  });
});

describe("dirty-pane flush pre-flight (MYND-617 task 8)", () => {
  it("flushes the target pane, then reads what the flush wrote", async () => {
    // Refusing instead would give a checkbox that intermittently does nothing
    // for reasons involving a pane the user may not be able to see.
    let flushed = false;
    const { d, written } = deps({
      flushDirtyPanes: async () => {
        flushed = true;
      },
      readNote: async () => {
        // Before the flush the disk body lacks the task entirely; after it, the
        // pane's pending edit is on disk and the read sees it.
        return flushed ? NOTE : "---\ntitle: Bills\n---\n";
      },
    });
    await setTaskCompleted(lineTask(), true, d);
    expect(written).toHaveLength(1);
    expect(written[0]!.body).toContain("- [x] pay the rent");
  });

  it("no pending edit is lost — the flush's bytes survive into the write", async () => {
    const pending = `---\ntitle: Bills\n---\n\n${LINE}\n\nkeystrokes the user just typed\n`;
    const { d, written } = deps({
      flushDirtyPanes: async () => {},
      readNote: async () => pending,
    });
    await setTaskCompleted(lineTask(), true, d);
    expect(written[0]!.body).toContain("keystrokes the user just typed");
  });

  it("the flush is the caller's existing mechanism, not a new one", async () => {
    // The writer never constructs a flush; it calls what it was handed. Omitting
    // it is legal (a surface with no panes to flush) and must not throw.
    const { d, written } = deps({ flushDirtyPanes: undefined });
    await setTaskCompleted(lineTask(), true, d);
    expect(written).toHaveLength(1);
  });
});
