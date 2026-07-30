// Query execution and the row limit (MYND-617 tasks 5 and 9).
//
// The evaluator is a pure function of (query, list, today, tagsOf), so the
// interesting properties are testable directly: a refused query evaluates
// NOTHING (the widening the guard exists to prevent), the limit is a bound with
// a stated remainder rather than a silent truncation, and the sort stays total.

import { describe, expect, it } from "vitest";
import { DEFAULT_QUERY_LIMIT, runTaskQuery } from "../../src/notes/taskQueryRun";
import { parseTaskQuery } from "../../src/notes/taskQuery";
import type { VaultTask } from "../../src/notes/taskIndex";

const TODAY = "2026-07-28";

function task(over: Partial<VaultTask> & { noteId?: string }): VaultTask {
  return {
    noteId: over.noteId ?? "n1",
    noteTitle: "Bills",
    noteFolder: "Projects",
    lineIndex: 0,
    rawLine: "- [ ] x",
    completed: false,
    oversized: false,
    ...over,
  } as VaultTask;
}

const run = (
  body: string,
  tasks: readonly VaultTask[],
  tagsOf?: (id: string) => readonly string[],
) => runTaskQuery(parseTaskQuery(body), tasks, TODAY, tagsOf);

describe("clauses filter", () => {
  const tasks = [
    task({ noteId: "a", completed: false, due: "2026-07-01" }),
    task({ noteId: "b", completed: true, due: "2026-08-15" }),
    task({ noteId: "c", completed: false }),
  ];

  it("completion state", () => {
    expect(run("not done", tasks).rows.map((t) => t.noteId)).toEqual(["a", "c"]);
    expect(run("done", tasks).rows.map((t) => t.noteId)).toEqual(["b"]);
  });

  it("due comparisons, resolved against the injected today", () => {
    expect(run("due before today", tasks).rows.map((t) => t.noteId)).toEqual(["a"]);
    expect(run("due after today", tasks).rows.map((t) => t.noteId)).toEqual(["b"]);
    expect(run("due on 2026-07-01", tasks).rows.map((t) => t.noteId)).toEqual(["a"]);
  });

  it("relative values resolve too", () => {
    expect(run("due after in 2 weeks", tasks).rows.map((t) => t.noteId)).toEqual(["b"]);
  });

  it("absence of a due date", () => {
    expect(run("no due date", tasks).rows.map((t) => t.noteId)).toEqual(["c"]);
  });

  it("path containment", () => {
    expect(run("path includes projects", tasks).rows).toHaveLength(3);
    expect(run("path includes personal", tasks).rows).toHaveLength(0);
  });

  it("priority", () => {
    const withPriority = [task({ noteId: "p", priority: "high" }), task({ noteId: "q" })];
    expect(run("priority is high", withPriority).rows.map((t) => t.noteId)).toEqual(["p"]);
  });

  it("tags, through the injected lookup, subtree-inclusively", () => {
    const tagged = [task({ noteId: "t1" }), task({ noteId: "t2" })];
    const tagsOf = (id: string) => (id === "t1" ? ["area/sub"] : ["other"]);
    expect(run("tag includes area", tagged, tagsOf).rows.map((t) => t.noteId)).toEqual(["t1"]);
  });

  it("a tag clause with no lookup matches NOTHING, not everything", () => {
    // Matching everything would silently widen the query — the exact failure
    // the widen guard exists to prevent, arriving by a different door.
    expect(run("tag includes work", tasks).rows).toHaveLength(0);
  });

  it("clauses are AND'd", () => {
    expect(run("not done\ndue before today", tasks).rows.map((t) => t.noteId)).toEqual(["a"]);
  });
});

describe("a refused query evaluates nothing", () => {
  const tasks = [task({ noteId: "a" }), task({ noteId: "b" })];

  it("returns no rows and reports the refusal", () => {
    const result = run("group by heading\nhide task count", tasks);
    expect(result.refused).toBe(true);
    expect(result.rows).toHaveLength(0);
    expect(result.matched).toBe(0);
  });

  it("a genuinely empty query IS unfiltered", () => {
    const result = run("", tasks);
    expect(result.refused).toBe(false);
    expect(result.rows).toHaveLength(2);
  });

  it("the two are distinguishable by more than row count", () => {
    // Both could return zero rows in a small vault; only one is `refused`.
    expect(run("group by heading", []).refused).toBe(true);
    expect(run("", []).refused).toBe(false);
  });
});

describe("the row limit is a bound with a stated remainder", () => {
  const many = Array.from({ length: 250 }, (_, i) =>
    task({ noteId: `n${i}`, lineIndex: i, due: "2026-08-01" }),
  );

  it("defaults to 100 rows", () => {
    expect(DEFAULT_QUERY_LIMIT).toBe(100);
    expect(run("not done", many).rows).toHaveLength(100);
  });

  it("states the remainder rather than truncating silently", () => {
    const result = run("not done", many);
    expect(result.remainder).toBe(150);
    expect(result.matched).toBe(250);
  });

  it("an explicit limit overrides the default", () => {
    const result = run("not done\nlimit 10", many);
    expect(result.rows).toHaveLength(10);
    expect(result.remainder).toBe(240);
  });

  it("an explicit limit ABOVE the match count leaves no remainder", () => {
    const result = run("not done\nlimit 9999", many);
    expect(result.rows).toHaveLength(250);
    expect(result.remainder).toBe(0);
  });

  it("a short result reports no remainder", () => {
    expect(run("not done", [task({})]).remainder).toBe(0);
  });
});

describe("sort", () => {
  const tasks = [
    task({ noteId: "later", due: "2026-09-01", priority: "low" }),
    task({ noteId: "sooner", due: "2026-08-01", priority: "highest" }),
    task({ noteId: "undated" }),
  ];

  it("defaults to due ascending with undated last", () => {
    expect(run("", tasks).rows.map((t) => t.noteId)).toEqual(["sooner", "later", "undated"]);
  });

  it("reverse flips the order but keeps undated last", () => {
    // Reversing must not promote an unscheduled task to the top: it was never
    // ranked, so it cannot be the most urgent.
    expect(run("sort by due reverse", tasks).rows.map((t) => t.noteId)).toEqual([
      "later",
      "sooner",
      "undated",
    ]);
  });

  it("sorts by priority, most urgent first", () => {
    expect(run("sort by priority", tasks).rows[0]!.noteId).toBe("sooner");
  });

  it("sorts by path", () => {
    const byPath = [
      task({ noteId: "z", noteFolder: "Zebra" }),
      task({ noteId: "a", noteFolder: "Apple" }),
    ];
    expect(run("sort by path", byPath).rows.map((t) => t.noteId)).toEqual(["a", "z"]);
  });

  it("is total — identical rows keep a stable order", () => {
    const a = task({ noteId: "n", due: "2026-08-01", lineIndex: 9 });
    const b = task({ noteId: "n", due: "2026-08-01", lineIndex: 2 });
    expect(run("", [a, b]).rows.map((t) => t.lineIndex)).toEqual([2, 9]);
    expect(run("", [b, a]).rows.map((t) => t.lineIndex)).toEqual([2, 9]);
  });
});

describe("it does not own its data", () => {
  it("never mutates the shared list", () => {
    const frozen = Object.freeze([
      task({ noteId: "b", due: "2026-09-01" }),
      task({ noteId: "a", due: "2026-08-01" }),
    ]);
    expect(() => run("", frozen)).not.toThrow();
    expect(frozen[0]!.noteId).toBe("b");
  });

  it("is a pure function of its inputs — no ambient clock", () => {
    const t = [task({ noteId: "x", due: "2026-07-28" })];
    const q = parseTaskQuery("due before today");
    expect(runTaskQuery(q, t, "2026-07-28", undefined).rows).toHaveLength(0);
    expect(runTaskQuery(q, t, "2026-07-29", undefined).rows).toHaveLength(1);
  });
});
