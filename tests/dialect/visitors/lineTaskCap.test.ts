// Raw-line cap with an oversized flag (MYND-612, task 5).
//
// The raw line is the authority for the pre-write verification, so a truncated one
// makes a task **unverifiable and therefore unwritable**. The record is still
// indexed and still returned — dropping it would make a task silently vanish from
// every surface — but it carries a flag, and the writer refuses on it rather than
// attempting a write it cannot verify.

import { describe, expect, it } from "vitest";
import {
  extractLineTasks,
  LINE_TASK_RAW_CAP,
} from "../../../src/dialect/visitors/lineTasks";
import { planLineTaskWrite } from "../../../src/dialect/taskFieldWriter";

function taskLine(padding: number): string {
  return `- [ ] ${"x".repeat(padding)} [due:: 2026-08-01]`;
}

describe("the cap", () => {
  it("stores a line at the cap in full", () => {
    const line = taskLine(LINE_TASK_RAW_CAP - "- [ ]  [due:: 2026-08-01]".length);
    expect(line.length).toBe(LINE_TASK_RAW_CAP);
    const [task] = extractLineTasks(`${line}\n`);
    expect(task.rawLine).toBe(line);
    expect(task.rawLine.length).toBe(LINE_TASK_RAW_CAP);
    expect(task.oversized).toBeUndefined();
  });

  it("stores an ordinary task's line in full", () => {
    const [task] = extractLineTasks("- [ ] pay the rent [due:: 2026-08-01]\n");
    expect(task.oversized).toBeUndefined();
    expect(task.rawLine).toBe("- [ ] pay the rent [due:: 2026-08-01]");
  });

  it("indexes an over-cap line rather than dropping it", () => {
    const tasks = extractLineTasks(`${taskLine(LINE_TASK_RAW_CAP)}\n`);
    expect(tasks).toHaveLength(1);
  });

  it("flags an over-cap line and truncates the stored text to the cap", () => {
    const [task] = extractLineTasks(`${taskLine(LINE_TASK_RAW_CAP)}\n`);
    expect(task.oversized).toBe(true);
    expect(task.rawLine.length).toBe(LINE_TASK_RAW_CAP);
  });

  it("still extracts the fields it could parse from an over-cap line", () => {
    // The fields are read from the full line before truncation, so an over-cap
    // task still appears under a date filter — it just cannot be written.
    const line = `- [ ] ${"x".repeat(LINE_TASK_RAW_CAP)} [due:: 2026-08-01]`;
    const [task] = extractLineTasks(`${line}\n`);
    expect(task.due).toBe("2026-08-01");
    expect(task.oversized).toBe(true);
  });
});

describe("the writer refuses a flagged record", () => {
  it("refuses, with a reason, rather than writing an unverifiable line", () => {
    const [task] = extractLineTasks(`${taskLine(LINE_TASK_RAW_CAP)}\n`);
    const result = planLineTaskWrite(task, { due: { date: "2026-09-09" }, preserved: [], malformed: [] });
    expect(result).toEqual({ ok: false, reason: "oversized" });
  });

  it("does not conflate refusal with 'nothing to change'", () => {
    // A no-op write and a refusal must be distinguishable, or a caller silently
    // treats a refused write as a successful one.
    const [unchanged] = extractLineTasks("- [ ] x [due:: 2026-08-01]\n");
    const noop = planLineTaskWrite(unchanged, {
      due: { date: "2026-08-01" },
      preserved: [],
      malformed: [],
    });
    expect(noop).toEqual({ ok: true, edit: null });
  });

  it("plans an ordinary edit for an unflagged record", () => {
    const [task] = extractLineTasks("- [ ] pay the rent [due:: 2026-08-01]\n");
    const result = planLineTaskWrite(task, {
      due: { date: "2026-09-01" },
      preserved: [],
      malformed: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const edit = result.edit!;
    const out =
      task.rawLine.slice(0, edit.range.start) + edit.text + task.rawLine.slice(edit.range.end);
    expect(out).toBe("- [ ] pay the rent [due:: 2026-09-01]");
  });
});

describe("the corpus stays far from the cap", () => {
  it("no fixture task line approaches 4000 characters", () => {
    const longest = [
      "- [ ] everything at once [due:: 2026-08-01] [repeat:: every week] [remind:: 2026-07-31 08:00] [priority:: highest] [done:: 2026-07-27]",
      "- [ ] obsidian's other keys [scheduled:: 2026-08-05] [start:: 2026-08-01] [cancelled:: 2026-08-09] [created:: 2026-07-01] [id:: abc] [dependsOn:: xyz]",
    ].reduce((a, b) => (a.length > b.length ? a : b));
    expect(longest.length).toBeLessThan(LINE_TASK_RAW_CAP / 10);
  });
});
