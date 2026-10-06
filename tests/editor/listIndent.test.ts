// myne-md/myne#658, Tab on a list line must land on a column the parser reads.
//
// The suite has two halves and both matter. The first drives
// `nextIndentColumn`, which is the decision. The second parses the RESULT with
// the real `@lezer/markdown`, because the whole bug was that a plausible indent
// produced a document the parser disagreed with, and a test that only checked
// the arithmetic would have passed for the two-space attempt that broke ordered
// lists.

import { describe, expect, it } from "vitest";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { listAwareIndent, nextIndentColumn } from "../../editor/src/list-indent";
import { indentUnit } from "@codemirror/language";
import { completeState } from "./_parse-budget";

describe("nextIndentColumn", () => {
  it("defers to indentMore on a line that is not a list item", () => {
    expect(nextIndentColumn("just prose", []).kind).toBe("defer");
    expect(nextIndentColumn("    code()", []).kind).toBe("defer");
  });

  it("indents a list under a paragraph by two, keeping it a list", () => {
    // One to three columns interrupt a paragraph; four or more do not.
    expect(nextIndentColumn("- [ ] child", ["pelin dilara çolak izle"])).toEqual({ kind: "indent", column: 2 });
  });

  it("reaches a bullet parent's content column", () => {
    expect(nextIndentColumn("- [ ] child", ["- parent"])).toEqual({ kind: "indent", column: 2 });
  });

  it("reaches an ORDERED parent's content column, which is not 2", () => {
    // The case the two-space attempt broke: `1. ` is column 3.
    expect(nextIndentColumn("- [ ] child", ["1. parent"])).toEqual({ kind: "indent", column: 3 });
  });

  it("reaches a wide ordered marker's column", () => {
    expect(nextIndentColumn("- [ ] child", ["10. parent"])).toEqual({ kind: "indent", column: 4 });
  });

  it("nests under the nearest item that is not deeper than this one", () => {
    expect(nextIndentColumn("  - [ ] child", ["- grandparent", "  - parent", "    - deeper"])).toEqual({ kind: "indent", column: 4 });
  });

  // The SECOND press, which the first version of this module got wrong and
  // which is myne#658 reproduced one keystroke later. `own + 2` unclamped walks
  // 0 to 2 to 4, and 4 is the lazy-continuation cliff, so the todo stops being
  // a task exactly as it did before the fix.
  it("refuses to walk a paragraph-interrupting list past column 3", () => {
    expect(nextIndentColumn("  - [ ] child", ["paragraph"])).toEqual({
      kind: "indent",
      column: 3,
    });
    expect(nextIndentColumn("   - [ ] child", ["paragraph"]).kind).toBe("noop");
    expect(nextIndentColumn("    - [ ] child", ["paragraph"]).kind).toBe("noop");
  });

  // `noop`, not `defer`. Deferring runs `indentMore`, which adds the whole
  // four-space unit on top of what is already there, so a list line with no
  // room left would land further past the cliff than it started.
  it("no-ops rather than deferring when a child is already at its parent's column", () => {
    expect(nextIndentColumn("  - [ ] child", ["- parent"]).kind).toBe("noop");
  });
});

describe("the indent the parser actually reads", () => {
  const nested = (doc: string): boolean => {
    const state = completeState(
      EditorState.create({
        doc,
        extensions: [markdown({ base: markdownLanguage })],
      }),
    );
    let depth = 0;
    let maxListDepth = 0;
    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name === "BulletList" || node.name === "OrderedList") {
          depth += 1;
          maxListDepth = Math.max(maxListDepth, depth);
        }
        return undefined;
      },
      leave: (node) => {
        if (node.name === "BulletList" || node.name === "OrderedList") depth -= 1;
      },
    });
    return maxListDepth >= 2;
  };

  const isTask = (doc: string): boolean => {
    const state = completeState(
      EditorState.create({
        doc,
        extensions: [markdown({ base: markdownLanguage })],
      }),
    );
    let found = false;
    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name === "TaskMarker" || node.name === "Task") found = true;
        return undefined;
      },
    });
    return found;
  };

  it("two columns under a paragraph keeps the todo a task", () => {
    expect(isTask("pelin dilara çolak izle\n  - [ ] admin preview\n")).toBe(true);
  });

  it("four columns under a paragraph does NOT, the reported bug", () => {
    expect(isTask("pelin dilara çolak izle\n    - [ ] admin preview\n")).toBe(false);
  });

  it("three columns under `1. ` nests; two does not", () => {
    // The regression the two-space indentUnit introduced, pinned so it cannot
    // come back as a "simplification".
    expect(nested("1. parent\n   - [ ] child\n")).toBe(true);
    expect(nested("1. parent\n  - [ ] child\n")).toBe(false);
  });

  it("two columns under `- ` nests", () => {
    expect(nested("- parent\n  - [ ] child\n")).toBe(true);
  });

  // Non-vacuity: the helper must be able to answer false, or every case above
  // is meaningless.
  it("a flat list is not reported as nested", () => {
    expect(nested("- one\n- two\n")).toBe(false);
  });
});

// The COMMAND, not just its arithmetic. Everything between the plan and the
// document lives here: the preceding-line gather with its blank-line stop, the
// `noop` arm, the space insertion and the caret shift. All of it survived being
// deleted while the helper suite stayed green.
describe("listAwareIndent", () => {
  /** Run Tab once with the caret at `caret`, return the resulting document. */
  function tab(doc: string, caret: number): string {
    let state = EditorState.create({
      doc,
      selection: { anchor: caret, head: caret },
      extensions: [markdown({ base: markdownLanguage }), indentUnit.of("    ")],
    });
    listAwareIndent({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
    return state.doc.toString();
  }

  const isTaskDoc = (doc: string): boolean => {
    const st = completeState(
      EditorState.create({
        doc,
        extensions: [markdown({ base: markdownLanguage })],
      }),
    );
    let found = false;
    syntaxTree(st).iterate({
      enter: (n) => {
        if (n.name === "TaskMarker" || n.name === "Task") found = true;
        return undefined;
      },
    });
    return found;
  };

  it("indents a todo under a paragraph to two columns", () => {
    const out = tab("para\n- [ ] x\n", 7);
    expect(out).toBe("para\n  - [ ] x\n");
    expect(isTaskDoc(out)).toBe(true);
  });

  // The second press, and the reason the command needs its own test: the plan
  // says `noop`, and a `noop` that fell through to `indentMore` would add the
  // four-space unit and destroy the task.
  it("refuses the second press rather than walking past the cliff", () => {
    const once = tab("para\n- [ ] x\n", 7);
    const twice = tab(once, once.indexOf("- [ ]") + 2);
    expect(twice).toBe("para\n   - [ ] x\n");
    expect(isTaskDoc(twice)).toBe(true);
    const thrice = tab(twice, twice.indexOf("- [ ]") + 2);
    expect(thrice).toBe(twice); // no change at all
    expect(isTaskDoc(thrice)).toBe(true);
  });

  it("indents a child to an ordered parent's content column", () => {
    expect(tab("1. parent\n- [ ] child\n", 12)).toBe("1. parent\n   - [ ] child\n");
  });

  it("leaves a non-list line to indentMore's four-space unit", () => {
    expect(tab("plain prose\n", 3)).toBe("    plain prose\n");
  });

  it("stops gathering context at a blank line", () => {
    // The bullet above is separated by a blank line, so it is a different list
    // and must not act as this item's parent.
    expect(tab("- far parent\n\n- [ ] x\n", 18)).toBe("- far parent\n\n  - [ ] x\n");
  });
});
