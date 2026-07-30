// Complete / un-complete orchestrators (MYND-613, task 4).
//
// The two properties worth testing are the ones a future change could silently
// break: the last-edited timestamp must NOT advance (flipping a managed flag is
// not a content edit — the rule trash and archive already follow), and the action
// must be refused on a note without the class marker (otherwise a note can be
// "completed" without being work, which no surface lists — invisible state).

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const { completeNote, uncompleteNote, isTaskNote, NotATaskNoteError } = await import(
  "../../src/notes/completeNote"
);
const { readDoneFromFmBody, readUpdatedFromFmBody } = await import(
  "../../src/dialect/surgery"
);

const TASK_NOTE = "---\ntitle: Ship it\nkind: task\nupdated: 2026-07-01T08:00:00Z\n---\n\nbody\n";
const PLAIN_NOTE = "---\ntitle: Meeting\nupdated: 2026-07-01T08:00:00Z\n---\n\nbody\n";

function fmBodyOf(source: string): string {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(source);
  return m ? (m[1] ?? "") : "";
}

/** The plaintext handed to `note_update` by the last call. */
function writtenPlaintext(): string {
  const call = invoke.mock.calls.find(([cmd]) => cmd === "plugin:notes|note_update");
  return (call?.[1] as { plaintext: string }).plaintext;
}

function mockRead(source: string): void {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "plugin:notes|note_read") return Promise.resolve(source);
    if (cmd === "plugin:notes|note_update") return Promise.resolve();
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

beforeEach(() => {
  invoke.mockReset();
});

describe("isTaskNote", () => {
  it("recognizes the canonical marker", () => {
    expect(isTaskNote(TASK_NOTE)).toBe(true);
  });

  it("rejects a note with no marker", () => {
    expect(isTaskNote(PLAIN_NOTE)).toBe(false);
  });

  it("rejects a non-canonical marker value", () => {
    expect(isTaskNote('---\nkind: "task"\n---\n\nbody\n')).toBe(false);
    expect(isTaskNote("---\nkind: Task\n---\n\nbody\n")).toBe(false);
  });

  it("rejects a note with no frontmatter at all", () => {
    expect(isTaskNote("# Just a body\n")).toBe(false);
  });
});

describe("completeNote", () => {
  it("writes the completion stamp through the existing update path", async () => {
    mockRead(TASK_NOTE);
    await completeNote("n1");

    const commands = invoke.mock.calls.map(([cmd]) => cmd);
    expect(commands).toEqual(["plugin:notes|note_read", "plugin:notes|note_update"]);
    expect(readDoneFromFmBody(fmBodyOf(writtenPlaintext()))).not.toBeNull();
  });

  it("adds no new backend command — only read and update are invoked", async () => {
    mockRead(TASK_NOTE);
    await completeNote("n1");
    for (const [cmd] of invoke.mock.calls) {
      expect(["plugin:notes|note_read", "plugin:notes|note_update"]).toContain(cmd);
    }
  });

  it("does NOT advance the last-edited timestamp", async () => {
    mockRead(TASK_NOTE);
    await completeNote("n1");
    expect(readUpdatedFromFmBody(fmBodyOf(writtenPlaintext()))).toBe("2026-07-01T08:00:00Z");
  });

  it("leaves the body and the other fields untouched", async () => {
    mockRead(TASK_NOTE);
    await completeNote("n1");
    const out = writtenPlaintext();
    expect(out).toContain("title: Ship it");
    expect(out).toContain("kind: task");
    expect(out).toContain("\nbody\n");
  });

  it("refreshes the stamp when completing an already-complete task", async () => {
    mockRead("---\nkind: task\ndone: 2026-01-01T00:00:00Z\n---\n\nbody\n");
    await completeNote("n1");
    const stamp = readDoneFromFmBody(fmBodyOf(writtenPlaintext()));
    expect(stamp).not.toBe("2026-01-01T00:00:00Z");
  });

  it("refuses on a note without the class marker, and writes nothing", async () => {
    mockRead(PLAIN_NOTE);
    await expect(completeNote("n1")).rejects.toBeInstanceOf(NotATaskNoteError);
    expect(invoke.mock.calls.map(([c]) => c)).toEqual(["plugin:notes|note_read"]);
  });
});

describe("uncompleteNote", () => {
  it("deletes the field rather than writing a falsy value", async () => {
    mockRead("---\nkind: task\ndone: 2026-07-27T10:00:00Z\n---\n\nbody\n");
    await uncompleteNote("n1");
    const out = writtenPlaintext();
    expect(readDoneFromFmBody(fmBodyOf(out))).toBeNull();
    expect(out).not.toContain("done:");
  });

  it("does not advance the last-edited timestamp either", async () => {
    mockRead("---\nkind: task\nupdated: 2026-07-01T08:00:00Z\ndone: 2026-07-27T10:00:00Z\n---\n\nbody\n");
    await uncompleteNote("n1");
    expect(readUpdatedFromFmBody(fmBodyOf(writtenPlaintext()))).toBe("2026-07-01T08:00:00Z");
  });

  it("is a no-op-safe write on a task that was not complete", async () => {
    mockRead(TASK_NOTE);
    await expect(uncompleteNote("n1")).resolves.toBeUndefined();
    expect(readDoneFromFmBody(fmBodyOf(writtenPlaintext()))).toBeNull();
  });

  it("refuses on a note without the class marker", async () => {
    mockRead(PLAIN_NOTE);
    await expect(uncompleteNote("n1")).rejects.toBeInstanceOf(NotATaskNoteError);
  });
});
