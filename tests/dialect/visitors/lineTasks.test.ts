// Line-task extractor over the shared parse (MYND-612, task 3).
//
// The extractor runs off the shared parse rather than a regex, and the exclusion
// zones are the reason: a regex would have to re-implement every one of them
// (code spans, fences, wikilink interiors, HTML, frontmatter), and would drift from
// the tokenizer the moment either changed. Running off the parse tree makes those
// exclusions free — the tokenizer never descends into those ranges — so the tests
// below are really asserting that the extractor did NOT reinvent the wheel.

import { describe, expect, it } from "vitest";
import { extractLineTasks } from "../../../src/dialect/visitors/lineTasks";

describe("what counts as a line-task", () => {
  it("extracts a plain task with its fields", () => {
    const src = "- [ ] pay the rent [due:: 2026-08-01]\n";
    expect(extractLineTasks(src)).toEqual([
      {
        lineIndex: 0,
        rawLine: "- [ ] pay the rent [due:: 2026-08-01]",
        completed: false,
        due: "2026-08-01",
      },
    ]);
  });

  it("records the line index of each task in a multi-line note", () => {
    const src = "# Heading\n\n- [ ] first\n- [x] second\n\ntext\n\n- [ ] third\n";
    expect(extractLineTasks(src).map((t) => t.lineIndex)).toEqual([2, 3, 7]);
  });

  it("stores the raw line verbatim, including non-canonical spacing", () => {
    const src = "-   [ ]   spaced   out   [due::2026-08-01]\n";
    expect(extractLineTasks(src)[0].rawLine).toBe("-   [ ]   spaced   out   [due::2026-08-01]");
  });

  it("extracts markers in nested lists", () => {
    const src = "- [ ] outer\n  - [ ] inner\n    - [x] deepest\n";
    expect(extractLineTasks(src).map((t) => t.completed)).toEqual([false, false, true]);
  });

  it("extracts markers inside blockquotes", () => {
    const src = "> - [ ] quoted task [due:: 2026-08-01]\n";
    const tasks = extractLineTasks(src);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].due).toBe("2026-08-01");
  });

  it("extracts markers inside a callout", () => {
    const src = "> [!note] Reminder\n> - [ ] inside a callout\n";
    expect(extractLineTasks(src)).toHaveLength(1);
  });

  it("extracts markers in ordered lists", () => {
    const src = "1. [ ] first\n2. [x] second\n";
    expect(extractLineTasks(src).map((t) => t.completed)).toEqual([false, true]);
  });
});

describe("uppercase markers", () => {
  it("extracts an uppercase [X] as done", () => {
    expect(extractLineTasks("- [X] shouted done\n")[0].completed).toBe(true);
  });

  it("leaves the uppercase marker unmodified in the raw line", () => {
    expect(extractLineTasks("- [X] shouted done\n")[0].rawLine).toBe("- [X] shouted done");
  });
});

describe("exclusion zones — free from the shared parse, not re-implemented", () => {
  it("ignores a marker inside a fenced code block", () => {
    const src = "```\n- [ ] not a task [due:: 2026-08-01]\n```\n";
    expect(extractLineTasks(src)).toEqual([]);
  });

  it("ignores a marker inside an indented code block", () => {
    const src = "text\n\n    - [ ] not a task\n";
    expect(extractLineTasks(src)).toEqual([]);
  });

  it("ignores a marker inside a code span", () => {
    expect(extractLineTasks("text `- [ ] not a task` more\n")).toEqual([]);
  });

  it("ignores a marker inside an HTML block", () => {
    expect(extractLineTasks("<div>\n- [ ] not a task\n</div>\n")).toEqual([]);
  });

  it("ignores markers inside frontmatter", () => {
    const src = "---\nsummary: - [ ] not a task\n---\n\n- [ ] a real one\n";
    const tasks = extractLineTasks(src);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].rawLine).toBe("- [ ] a real one");
  });

  it("ignores a marker inside a wikilink interior", () => {
    expect(extractLineTasks("see [[a note - [ ] inside]]\n")).toEqual([]);
  });
});

describe("drawing-class notes", () => {
  it("produces zero records for a note whose kind is drawing", () => {
    // A drawing's body is serialized scene JSON; a marker inside it is a phantom
    // task, so the whole note is skipped rather than filtered line by line.
    const src =
      '---\nkind: drawing\n---\n\n```excalidraw\n{"elements":[{"text":"- [ ] not a task"}]}\n```\n';
    expect(extractLineTasks(src)).toEqual([]);
  });

  it("still extracts from an ordinary note that merely mentions drawing", () => {
    const src = "---\ntitle: about drawing\n---\n\n- [ ] a real task\n";
    expect(extractLineTasks(src)).toHaveLength(1);
  });
});

describe("field extraction rides on the dialect parser", () => {
  it("reads all five written fields", () => {
    const src =
      "- [x] everything [due:: 2026-08-01] [repeat:: every week] [done:: 2026-07-27] [priority:: high] [remind:: 2026-07-30 09:00]\n";
    expect(extractLineTasks(src)[0]).toEqual({
      lineIndex: 0,
      rawLine: src.trimEnd(),
      completed: true,
      due: "2026-08-01",
      repeat: "every week",
      done: "2026-07-27",
      priority: "high",
      remind: "2026-07-30 09:00",
    });
  });

  it("reads the emoji dialect identically", () => {
    const emoji = extractLineTasks("- [x] ship ✅ 2026-07-27 📅 2026-08-01 ⏫\n")[0];
    expect(emoji.due).toBe("2026-08-01");
    expect(emoji.done).toBe("2026-07-27");
    expect(emoji.priority).toBe("high");
  });

  it("omits a field whose value did not type rather than inventing one", () => {
    const t = extractLineTasks("- [ ] half date [due:: 2026-08]\n")[0];
    expect(t.due).toBeUndefined();
    expect(t.rawLine).toContain("[due:: 2026-08]");
  });

  it("emits no field keys at all for a task carrying none", () => {
    expect(extractLineTasks("- [ ] bare\n")).toEqual([
      { lineIndex: 0, rawLine: "- [ ] bare", completed: false },
    ]);
  });
});

describe("empty and degenerate input", () => {
  it("returns an empty list for an empty document", () => {
    expect(extractLineTasks("")).toEqual([]);
  });

  it("returns an empty list for a note with no tasks", () => {
    expect(extractLineTasks("# Title\n\nJust prose.\n")).toEqual([]);
  });

  it("ignores an ordinary list item with no marker", () => {
    expect(extractLineTasks("- not a task\n")).toEqual([]);
  });
});
