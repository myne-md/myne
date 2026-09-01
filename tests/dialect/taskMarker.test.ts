// The GFM task-marker shape, stated once (myne-md/myne#593).
//
// The separator after `[ ]` is not decoration: `@lezer/markdown`'s GFM
// `TaskList` leaf requires it, so `- [ ]foo` is an ordinary bullet item whose
// text happens to start with `[ ]`, and no reader treats it as a task.
//
// That shape had been restated in five places in four forms, and two of them
// left the separator out, so a field written by `taskFieldWriter` or a checkbox
// flipped by `taskWriteCore` could land on a line nothing parses as a task. Both
// now build on this module, and these cases are what would have caught them.

import { describe, expect, it } from "vitest";
import {
  TASK_LINE_RE,
  TASK_MARKER_RE,
  isTaskLine,
  isTaskMarker,
} from "../../dialect/src/taskMarker";
// `taskFieldWriter` exports its OWN `isTaskLine`, built from the writer-side
// marker. Aliased rather than shadowed so each case says which of the two it
// is asserting: the writer's must stay strict while the STRIPPING regex
// beside it went lax, and that split is the whole fix.
import {
  isTaskLine as writerIsTaskLine,
  taskDescription,
} from "../../dialect/src/taskFieldWriter";

describe("isTaskMarker, the text after a list marker", () => {
  it("accepts the three checkbox spellings with a space", () => {
    expect(isTaskMarker("[ ] a")).toBe(true);
    expect(isTaskMarker("[x] a")).toBe(true);
    expect(isTaskMarker("[X] a")).toBe(true);
  });

  it("accepts a tab as the separator, which the parser does", () => {
    expect(isTaskMarker("[ ]\ta")).toBe(true);
  });

  it("REJECTS a checkbox with no separator", () => {
    // The whole point. `- [ ]foo` renders no checkbox, so a predicate that says
    // yes here disagrees with the parser and every reader downstream.
    expect(isTaskMarker("[ ]foo")).toBe(false);
  });

  it("rejects a checkbox that is not at the start", () => {
    expect(isTaskMarker(" [ ] a")).toBe(false);
    expect(isTaskMarker("x [ ] a")).toBe(false);
  });

  it("rejects a checkbox carrying anything else inside", () => {
    expect(isTaskMarker("[y] a")).toBe(false);
    expect(isTaskMarker("[] a")).toBe(false);
    expect(isTaskMarker("[  ] a")).toBe(false);
  });
});

describe("isTaskLine, a whole line", () => {
  it("accepts the bullet markers GFM defines the extension on", () => {
    expect(isTaskLine("- [ ] a")).toBe(true);
    expect(isTaskLine("* [x] a")).toBe(true);
    expect(isTaskLine("+ [X] a")).toBe(true);
  });

  it("accepts an indented one", () => {
    expect(isTaskLine("    - [ ] a")).toBe(true);
    expect(isTaskLine("\t- [ ] a")).toBe(true);
  });

  it("REJECTS a checkbox with no separator", () => {
    // The exact input the two lax copies accepted.
    expect(writerIsTaskLine("- [ ]foo")).toBe(false);
  });

  it("rejects an ORDERED marker", () => {
    // GFM defines task lists on bullet lists. A caller that wants `1. [ ]` to
    // count is asking for something else and should say so.
    expect(isTaskLine("1. [ ] a")).toBe(false);
  });

  it("rejects prose and a bare bullet", () => {
    expect(isTaskLine("just text")).toBe(false);
    expect(isTaskLine("- plain item")).toBe(false);
    expect(isTaskLine("- [ ]")).toBe(false);
  });

  it("captures the prefix and the checkbox character, for an in-place rewrite", () => {
    // `flipMarker` rebuilds the line from these two, and it must not normalise
    // an imported `[X]` to `[x]`: `markdown-dialect.md` §6 C1 and `TaskRecord`'s
    // own doc both promise the uppercase marker survives.
    const m = TASK_LINE_RE.exec("  * [X] done");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("  * ");
    expect(m![2]).toBe("X");
  });

  it("is anchored, so it cannot match mid-line", () => {
    expect(TASK_MARKER_RE.source.startsWith("^")).toBe(true);
    expect(TASK_LINE_RE.source.startsWith("^")).toBe(true);
  });
});

describe("taskDescription strips the marker even without a trailing separator", () => {
  // The consolidation gave `TASK_LINE_MARKER` the parser's REQUIRED separator
  // lookahead, and `taskDescription` runs over text `stripFieldSpans` has
  // already right-trimmed. So on a line whose description is empty, or was
  // nothing but fields, the separator is gone before the strip runs and the
  // marker survived: the Tasks panel and every `task-query` block rendered the
  // literal "- [ ]" where the untitled placeholder belongs. `/due` on a blank
  // line auto-converts to "- [ ] " and writes the field, so it was one
  // documented keystroke away.
  //
  // Deciding whether a line IS a task still requires the separator. Removing the
  // marker must not. Two questions, two expressions.
  it("strips the marker from a line whose description is only fields", () => {
    // The field text survives here because `fieldRanges` needs a parse tree to
    // locate spans and this call supplies none, so `stripFieldSpans` removes
    // nothing. That is beside the point being pinned: what must not survive is
    // the MARKER, and with the required-separator regex it did, because the
    // right-trim had already eaten the separator the regex insisted on.
    const out = taskDescription("- [ ] @due(2026-01-01)");
    expect(out.startsWith("- [")).toBe(false);
    expect(out).toBe("@due(2026-01-01)");
  });

  it("returns empty for a task line with nothing after the checkbox", () => {
    expect(taskDescription("- [ ] ")).toBe("");
    expect(taskDescription("- [ ]")).toBe("");
  });

  it("still keeps an ordinary description", () => {
    expect(taskDescription("- [x] buy milk")).toBe("buy milk");
  });

  it("still refuses a line the parser does not see as a task", () => {
    // `- [ ]foo` has no separator, so GFM reads an ordinary bullet whose text
    // begins with "[ ]". The stripping regex being laxer must not make
    // `isTaskLine` laxer with it.
    expect(isTaskLine("- [ ]foo")).toBe(false);
  });
});
