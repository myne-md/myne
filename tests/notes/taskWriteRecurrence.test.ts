// @vitest-environment jsdom
//
// A task ticked from a LIST recurs too (myne#198).
//
// The editor's checkbox and the Tasks panel are two surfaces over one file
// format, and a user does not know which one they used a week later. So the
// panel's writer performs the same materialization the checkbox does — same
// dialect functions, so the two cannot drift — and these tests pin the parts
// that are specific to writing a note rather than editing a document: the
// occurrence rides the SAME note write (one hash guard, one snapshot), and the
// safety refusals that already governed this path still govern it.

import { describe, expect, it } from "vitest";
import { setTaskCompleted } from "../../src/notes/toggleTask";
import { TaskWriteRefused, type TaskWriteDeps } from "../../src/notes/taskWriteCore";
import type { VaultTask } from "../../src/notes/taskIndex";

const TODAY = () => ({ year: 2026, month: 7, day: 28 });

const LINE = "- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]";
const TICKED = "- [x] pay rent [due:: 2026-07-01] [repeat:: every month]";
const OCCURRENCE = "- [ ] pay rent [due:: 2026-08-01] [repeat:: every month]";

/** A note whose line 4 (0-indexed) is the task. */
function note(line: string, after = "\n\nsome prose\n"): string {
  return `---\ntitle: Bills\n---\n\n${line}${after}`;
}

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

function deps(source: string, over: Partial<TaskWriteDeps> = {}) {
  const written: string[] = [];
  const d: TaskWriteDeps = {
    readNote: async () => source,
    writeNote: async (_id, body) => {
      written.push(body);
    },
    completeNoteTask: async () => {},
    uncompleteNoteTask: async () => {},
    announce: () => {},
    today: TODAY,
    ...over,
  };
  return { d, written };
}

describe("completing a recurring task from a list", () => {
  it("inserts the next occurrence directly after it", async () => {
    const { d, written } = deps(note(LINE));
    await setTaskCompleted(lineTask(), true, d);

    expect(written.length).toBe(1);
    const lines = written[0]!.split("\n");
    expect(lines[4]).toBe(TICKED);
    expect(lines[5]).toBe(OCCURRENCE);
    expect(lines[6]).toBe(""); // the blank line that followed is still there
    expect(lines[7]).toBe("some prose");
  });

  it("writes both changes in ONE note write, under one hash guard", async () => {
    // Two writes would mean two snapshots, two chances for a sync pull to land
    // in between, and a window where the file says "completed" with no
    // successor.
    const hashes: string[] = [];
    const { d, written } = deps(note(LINE), {
      writeNote: async (_id, body, hash) => {
        written.push(body);
        hashes.push(hash);
      },
    });
    await setTaskCompleted(lineTask(), true, d);
    expect(written.length).toBe(1);
    expect(hashes.length).toBe(1);
  });

  it("leaves a non-recurring task's line count alone", async () => {
    const plain = "- [ ] one-off [due:: 2026-07-01]";
    const { d, written } = deps(note(plain), { });
    await setTaskCompleted(lineTask({ rawLine: plain }), true, d);
    expect(written[0]!.split("\n").length).toBe(note(plain).split("\n").length);
  });

  it("keeps the file's own line endings on a CRLF note", async () => {
    // The `\n` split leaves a stray `\r` on every line; a materialized
    // occurrence must carry one too rather than introducing a second convention
    // halfway down the file.
    const crlf = note(LINE).replace(/\n/g, "\r\n");
    const { d, written } = deps(crlf);
    await setTaskCompleted(lineTask(), true, d);
    expect(written[0]!.split("\r\n")[5]).toBe(OCCURRENCE);
    expect(written[0]).not.toMatch(/[^\r]\n/); // no bare LF anywhere
  });

  it("still refuses when the stored raw line no longer matches disk", async () => {
    // The recurrence path must not weaken the guard that stops a write landing
    // on whatever now occupies that line number.
    const { d, written } = deps(note("- [ ] something else entirely"));
    await expect(setTaskCompleted(lineTask(), true, d)).rejects.toBeInstanceOf(TaskWriteRefused);
    expect(written.length).toBe(0);
  });

  it("still refuses an oversized record before computing anything", async () => {
    const { d, written } = deps(note(LINE));
    await expect(
      setTaskCompleted(lineTask({ oversized: true }), true, d),
    ).rejects.toBeInstanceOf(TaskWriteRefused);
    expect(written.length).toBe(0);
  });
});

describe("un-completing a recurring task from a list", () => {
  it("removes the occurrence it materialized", async () => {
    const { d, written } = deps(note(`${TICKED}\n${OCCURRENCE}`));
    await setTaskCompleted(lineTask({ rawLine: TICKED, completed: true }), false, d);

    const lines = written[0]!.split("\n");
    expect(lines[4]).toBe(LINE);
    expect(written[0]).not.toContain(OCCURRENCE);
    expect(lines[5]).toBe(""); // the prose that followed is undisturbed
    expect(lines[6]).toBe("some prose");
  });

  it("leaves a successor the user edited alone", async () => {
    const edited = `${OCCURRENCE} [priority:: high]`;
    const { d, written } = deps(note(`${TICKED}\n${edited}`));
    await setTaskCompleted(lineTask({ rawLine: TICKED, completed: true }), false, d);

    const lines = written[0]!.split("\n");
    expect(lines[4]).toBe(LINE);
    expect(lines[5]).toBe(edited);
  });

  it("leaves an unrelated following line alone", async () => {
    const { d, written } = deps(note(TICKED));
    await setTaskCompleted(lineTask({ rawLine: TICKED, completed: true }), false, d);

    const lines = written[0]!.split("\n");
    expect(lines[4]).toBe(LINE);
    expect(lines[5]).toBe("");
    expect(lines[6]).toBe("some prose");
  });

  it("does nothing when the task is the last line of the note", async () => {
    const { d, written } = deps(note(TICKED, ""));
    await setTaskCompleted(lineTask({ rawLine: TICKED, completed: true }), false, d);
    expect(written[0]!.split("\n")[4]).toBe(LINE);
  });
});
