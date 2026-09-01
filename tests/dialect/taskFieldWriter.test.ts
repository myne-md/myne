// Single writer seam: typed record to bytes (MYND-611, task 3).
//
// This is the ONLY place in the codebase that emits task-field bytes. A second body
// writer would be a regression against the recorded single-writer discipline, and it
// is what makes a future format switch a one-line change (SYNC-30 and SYNC-34 both
// depend on it).
//
// It returns a change specification rather than dispatching, so MYND-614's chip edit
// can bundle it into one transaction and one undo.

import { describe, expect, it } from "vitest";
import { parseTaskFields } from "../../src/dialect/taskFields";
import {
  isTaskLine,
  planTaskFieldWrite,
  serializeTaskFields,
} from "../../src/dialect/taskFieldWriter";

/** Apply a planned edit to a line, the way a caller's transaction would. */
function applyPlan(line: string, next: Parameters<typeof planTaskFieldWrite>[1]): string {
  const edit = planTaskFieldWrite(line, next);
  if (edit === null) return line;
  return line.slice(0, edit.range.start) + edit.text + line.slice(edit.range.end);
}

describe("isTaskLine", () => {
  it("recognizes a task line in either checkbox state, any marker, indented", () => {
    expect(isTaskLine("- [ ] pay the rent")).toBe(true);
    expect(isTaskLine("- [x] done")).toBe(true);
    expect(isTaskLine("- [X] done")).toBe(true);
    expect(isTaskLine("  * [ ] indented")).toBe(true);
    expect(isTaskLine("+ [ ] plus marker")).toBe(true);
  });

  it("rejects prose, a plain bullet, and a heading — the add-field guard", () => {
    expect(isTaskLine("just prose")).toBe(false);
    expect(isTaskLine("- a bullet, no checkbox")).toBe(false);
    expect(isTaskLine("# heading")).toBe(false);
    expect(isTaskLine("")).toBe(false);
  });
});

describe("serialization form", () => {
  it("emits the bracketed form with Myne's key names", () => {
    const text = serializeTaskFields({
      due: { date: "2026-08-01" },
      done: { date: "2026-07-27" },
      preserved: [],
      malformed: [],
    });
    expect(text).toBe("[due:: 2026-08-01] [done:: 2026-07-27]");
  });

  it("writes a time when the instant carries one", () => {
    expect(
      serializeTaskFields({
        due: { date: "2026-08-01", time: "14:30" },
        preserved: [],
        malformed: [],
      }),
    ).toBe("[due:: 2026-08-01 14:30]");
  });

  it("emits fields in a stable order regardless of record key order", () => {
    const a = serializeTaskFields({
      remind: { date: "2026-07-29" },
      due: { date: "2026-08-01" },
      priority: "high",
      preserved: [],
      malformed: [],
    });
    expect(a).toBe("[due:: 2026-08-01] [priority:: high] [remind:: 2026-07-29]");
  });

  it("never emits an emoji marker — Obsidian parity is a read goal only", () => {
    const text = serializeTaskFields({
      due: { date: "2026-08-01" },
      repeat: "every week",
      priority: "high",
      preserved: [],
      malformed: [],
    });
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{23E9}-\u{23FA}]/u);
  });

  it("emits nothing for an empty record", () => {
    expect(serializeTaskFields({ preserved: [], malformed: [] })).toBe("");
  });
});

describe("round-trip through the parser", () => {
  const records = [
    { due: { date: "2026-08-01" }, preserved: [], malformed: [] },
    { due: { date: "2026-08-01", time: "14:30" }, preserved: [], malformed: [] },
    {
      due: { date: "2026-08-01" },
      repeat: "every 3 days",
      done: { date: "2026-07-27" },
      priority: "low" as const,
      remind: { date: "2026-07-29", time: "09:00" },
      preserved: [],
      malformed: [],
    },
  ];

  it("writing a record and re-parsing it yields the same record", () => {
    for (const record of records) {
      const line = `- [ ] task ${serializeTaskFields(record)}`;
      const back = parseTaskFields(line);
      expect(back.due).toEqual(record.due);
      expect(back.repeat).toEqual(record.repeat);
      expect(back.done).toEqual(record.done);
      expect(back.priority).toEqual(record.priority);
      expect(back.remind).toEqual(record.remind);
    }
  });

  it("round-trips a record read out of the emoji dialect", () => {
    const original = parseTaskFields("- [x] ship it ✅ 2026-07-27 📅 2026-08-01 🔁 every week ⏫");
    const line = `- [x] ship it ${serializeTaskFields(original)}`;
    expect(parseTaskFields(line)).toEqual(original);
  });
});

describe("planned edit", () => {
  it("preserves the untouched bytes of the line exactly", () => {
    const line = "- [ ] pay the rent [due:: 2026-08-01]";
    const out = applyPlan(line, { due: { date: "2026-09-01" }, preserved: [], malformed: [] });
    expect(out).toBe("- [ ] pay the rent [due:: 2026-09-01]");
  });

  it("appends fields to a line that had none", () => {
    const out = applyPlan("- [ ] pay the rent", {
      due: { date: "2026-08-01" },
      preserved: [],
      malformed: [],
    });
    expect(out).toBe("- [ ] pay the rent [due:: 2026-08-01]");
  });

  it("converts an emoji-form line to Myne's form wholesale", () => {
    const line = "- [ ] water plants 🔁 every 3 days 📅 2026-08-01";
    const current = parseTaskFields(line);
    const out = applyPlan(line, { ...current, due: { date: "2026-08-02" } });
    expect(out).toBe("- [ ] water plants [due:: 2026-08-02] [repeat:: every 3 days]");
  });

  it("keeps description text that sits between fields", () => {
    const line = "- [ ] call [due:: 2026-08-01] the plumber";
    const out = applyPlan(line, { due: { date: "2026-08-05" }, preserved: [], malformed: [] });
    expect(out).toBe("- [ ] call the plumber [due:: 2026-08-05]");
  });

  it("returns null when nothing would change", () => {
    const line = "- [ ] x [due:: 2026-08-01]";
    expect(planTaskFieldWrite(line, parseTaskFields(line))).toBeNull();
  });

  it("touches no other line in a multi-line document", () => {
    const doc = "- [ ] first [due:: 2026-08-01]\n- [ ] second [due:: 2026-08-02]\n";
    const firstLine = doc.slice(0, doc.indexOf("\n"));
    const edit = planTaskFieldWrite(firstLine, {
      due: { date: "2026-09-09" },
      preserved: [],
      malformed: [],
    })!;
    const out = doc.slice(0, edit.range.start) + edit.text + doc.slice(edit.range.end);
    expect(out).toBe("- [ ] first [due:: 2026-09-09]\n- [ ] second [due:: 2026-08-02]\n");
  });
});

describe("unsupported fields survive a write to a different field", () => {
  it("carries Obsidian's unsupported keys through unchanged", () => {
    const line = "- [ ] x [scheduled:: 2026-08-05] [id:: abc] [due:: 2026-08-01]";
    const current = parseTaskFields(line);
    const out = applyPlan(line, { ...current, due: { date: "2026-08-09" } });
    expect(out).toContain("[scheduled:: 2026-08-05]");
    expect(out).toContain("[id:: abc]");
    expect(out).toContain("[due:: 2026-08-09]");
  });

  it("carries onCompletion through a write without interpreting it", () => {
    const line = "- [ ] x [onCompletion:: delete] [due:: 2026-08-01]";
    const current = parseTaskFields(line);
    const out = applyPlan(line, { ...current, due: { date: "2026-08-09" } });
    expect(out).toContain("[onCompletion:: delete]");
  });

  it("carries a malformed value through verbatim rather than dropping it", () => {
    const line = "- [ ] x [due:: 2026-02-31] [priority:: high]";
    const current = parseTaskFields(line);
    expect(current.malformed).toHaveLength(1);
    const out = applyPlan(line, { ...current, priority: "low" });
    expect(out).toContain("2026-02-31");
    expect(out).toContain("[priority:: low]");
  });
});

describe("clearing the last field leaves a line the parser still reads as a task", () => {
  // myne-md/myne#593's marker consolidation made both repair paths
  // (`isTaskLine`, `flipMarker`) require the GFM separator after `[ ]`. This
  // writer could still EMIT a line without one: `stripFieldSpans` right-trims,
  // so clearing the last field from a description-less task produced `- [ ]`,
  // which no reader parses as a task and no writer could then flip or rewrite.
  // The bytes stayed intact, which is what made it quiet: a persisted task
  // silently became prose the task machinery would not touch again.
  const EMPTY = { preserved: [], malformed: [] };

  it("keeps the separator when nothing but the marker would remain", () => {
    expect(applyPlan("- [ ] [due:: 2026-08-01]", EMPTY)).toBe("- [ ] ");
  });

  it("and the result still reads as a task, which is the whole point", () => {
    expect(isTaskLine(applyPlan("- [x] [due:: 2026-08-01]", EMPTY))).toBe(true);
  });

  it("does not add a separator to a line that already has a description", () => {
    // The restoration is for the marker-only case alone; a normal clear must
    // not gain a trailing space it did not have.
    expect(applyPlan("- [ ] call the plumber [due:: 2026-08-01]", EMPTY)).toBe(
      "- [ ] call the plumber",
    );
  });
});
