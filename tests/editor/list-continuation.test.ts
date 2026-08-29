// @vitest-environment jsdom
//
// Enter inside a list (myne-md/myne#588, #593): what the keypress INSERTS.
//
// Two assertions per task case, deliberately: the resulting text, and that the
// item left above the split still PARSES as a task. Text alone passes on
// `- [ ]`, which is exactly the bug: the bytes look right and the parser has
// stopped seeing a task item, so the checkbox is gone and the raw marker is what
// the user is looking at.

import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { continueListMarkup } from "../../src/editor/list-continuation";

interface Mounted {
  readonly view: EditorView;
  readonly host: HTMLElement;
}

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) {
    m.view.destroy();
    m.host.remove();
  }
  m = null;
});

function mount(doc: string, anchor: number): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown({ base: markdownLanguage })],
    }),
    parent: host,
  });
  forceParsing(view);
  return { view, host };
}

/** Press Enter at `anchor` and report what the document and caret became. */
function enter(
  doc: string,
  anchor: number,
): {
  handled: boolean;
  doc: string;
  head: number;
} {
  m = mount(doc, anchor);
  const view = m.view;
  let applied: Transaction | null = null;
  const handled = continueListMarkup({
    state: view.state,
    dispatch: (tr) => {
      applied = tr;
    },
  });
  const tr = applied as Transaction | null;
  return {
    handled,
    doc: tr === null ? view.state.doc.toString() : tr.state.doc.toString(),
    head:
      tr === null
        ? view.state.selection.main.head
        : tr.state.selection.main.head,
  };
}

/** How many task items `doc` parses as. The rendered checkbox is a decoration
 *  over `TaskMarker`, so a document with no such node has no checkbox.
 *
 *  Parsed directly rather than through a view: `parser.parse` returns a complete
 *  tree, which is the whole reason the mounted variant needed `forceParsing`. */
function taskItems(doc: string): number {
  let count = 0;
  markdownLanguage.parser.parse(doc).iterate({
    enter: (n) => {
      if (n.name === "TaskMarker") count += 1;
    },
  });
  return count;
}

describe("the list stays as tight as the user wrote it (#588)", () => {
  it("continues a tight bullet list with one line break", () => {
    expect(enter("- a\n- b", 7).doc).toBe("- a\n- b\n- ");
  });

  it("continues a LOOSE bullet list with one line break too", () => {
    expect(enter("- a\n\n- b", 8).doc).toBe("- a\n\n- b\n- ");
  });

  it("continues a loose task list with one line break", () => {
    const after = enter("- [ ] a\n\n- [ ] b", 16);
    expect(after.doc).toBe("- [ ] a\n\n- [ ] b\n- [ ] ");
    expect(taskItems(after.doc)).toBe(3);
  });

  it("continues a loose ordered list with one line break, and keeps numbering", () => {
    expect(enter("1. a\n\n2. b", 10).doc).toBe("1. a\n\n2. b\n3. ");
  });

  it("leaves the blank lines the user already wrote exactly where they are", () => {
    // The blank line between a and b survives; only the NEW item is tight.
    expect(enter("- a\n\n- b", 8).doc.split("\n")).toEqual([
      "- a",
      "",
      "- b",
      "- ",
    ]);
  });

  it("keeps the caret on the new item, not on a blank line above it", () => {
    const after = enter("- [ ] a\n\n- [ ] b", 16);
    expect(after.head).toBe(after.doc.length);
    expect(after.doc.slice(0, after.head).endsWith("\n- [ ] ")).toBe(true);
  });
});

describe("a task marker keeps its separator (#593)", () => {
  it("leaves a task item, not raw markup, when the split is at the label", () => {
    const after = enter("- [ ] foo", 6);
    expect(after.doc).toBe("- [ ] \n- [ ] foo");
    // The half above the split is still a task item, which is the whole point.
    expect(taskItems(after.doc)).toBe(2);
    expect(taskItems(after.doc.split("\n")[0]!)).toBe(1);
  });

  it("does the same when the caret is tight against `]`", () => {
    const after = enter("- [ ] foo", 5);
    expect(after.doc).toBe("- [ ] \n- [ ] foo");
    expect(taskItems(after.doc)).toBe(2);
  });

  it("keeps ONE separator above a wide one, and does not double the one below", () => {
    // Upstream mirrors the item's own separator width into the new marker
    // (`- [ ]` + four spaces here) and strips the trailing whitespace from the
    // line it splits. Only the second half is ours to change, and only by the
    // one character the parser requires: the residue keeps a single space, the
    // new item keeps the width the user chose.
    const fromLabel = enter("- [ ]    foo", 9);
    expect(fromLabel.doc).toBe("- [ ] \n- [ ]    foo");
    expect(taskItems(fromLabel.doc)).toBe(2);

    // Same line, caret tight against `]`: the separator is still ahead of the
    // caret, so without the swallow it would land on top of the marker's own.
    const fromMarker = enter("- [ ]    foo", 5);
    expect(fromMarker.doc).toBe("- [ ] \n- [ ]    foo");
    expect(taskItems(fromMarker.doc)).toBe(2);
  });

  it("carries a TAB at the split point instead of deleting it", () => {
    // The separator collapse is about spaces, and it used to be about
    // whitespace. A tab after the marker is indentation the author typed, which
    // `markdown-dialect.md` §6 C1 says survives a round trip; the run of spaces
    // this repair collapses is the separator it is re-adding one of.
    //
    // Measured against `insertNewlineContinueMarkupCommand` before the fix:
    // upstream gives `- [ ]\n- \ttab` and this command gave `- [ ] \n- tab`,
    // one byte of the document simply gone. Every non-whitespace byte survived,
    // which is why nothing else caught it.
    const after = enter("- [ ]\ttab", 5);
    expect(after.doc).toContain("\t");
    expect(after.doc).toBe("- [ ] \n- \ttab");
  });

  it("does not ADD whitespace the author never typed", () => {
    // The other wrong answer, also measured: collapsing exactly one space
    // instead of the run leaves three where the author wrote two, because the
    // split consumes one and the markup adds one back. The count on the new line
    // has to come out at what was there.
    const two = enter("- [ ]  foo", 5);
    expect(two.doc).toBe("- [ ] \n- [ ]  foo");
    const one = enter("- [ ] foo", 5);
    expect(one.doc).toBe("- [ ] \n- [ ] foo");
  });

  it("keeps the nesting indent of a nested task item", () => {
    const after = enter("  - [ ] foo bar", 8);
    expect(after.doc).toBe("  - [ ] \n  - [ ] foo bar");
    expect(taskItems(after.doc)).toBe(2);
  });

  it("puts the caret before the text that moved down", () => {
    const after = enter("- [ ] foo", 6);
    expect(after.doc.slice(after.head)).toBe("foo");
  });

  it("still ends a task item at end-of-line with a separator to type after", () => {
    const after = enter("- [ ] foo", 9);
    expect(after.doc).toBe("- [ ] foo\n- [ ] ");
    expect(taskItems(after.doc)).toBe(2);
  });
});

describe("everything the repairs do not name is upstream behaviour", () => {
  it("deletes a level of markup on an empty item (myne#562, not re-broken)", () => {
    expect(enter("- a\n- ", 6).doc).toBe("- a\n");
    expect(enter("- [ ] a\n- [ ] ", 14).doc).toBe("- [ ] a\n");
  });

  it("renumbers the items below an insertion in an ordered list", () => {
    expect(enter("1. a\n2. b\n3. c", 8).doc).toBe("1. a\n2.\n3. b\n4. c");
  });

  it("continues a blockquote", () => {
    expect(enter("> quoted", 8).doc).toBe("> quoted\n> ");
  });

  it("continues a list inside a blockquote", () => {
    expect(enter("> - a", 5).doc).toBe("> - a\n> - ");
  });

  it("declines outside a markup context, so the default Enter runs", () => {
    expect(enter("hello", 5).handled).toBe(false);
  });

  it("declines with the caret inside the marker's own columns", () => {
    // Upstream's own rule: at the very start of a list line, Enter is a plain
    // newline. The repairs must not turn that into a continuation.
    expect(enter("- [ ] foo", 0).handled).toBe(false);
  });
});

describe("a multi-cursor keeps every caret", () => {
  /** Press Enter with TWO carets and report the resulting selection. */
  function enterTwice(doc: string, a: number, b: number) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.create(
          [EditorSelection.cursor(a), EditorSelection.cursor(b)],
          0,
        ),
        // CM6 defaults this facet to FALSE and silently collapses a
        // multi-range selection to its main range when it is off, so without it
        // this harness cannot express the case at all: the first version of
        // this test failed on a one-range selection and read as a product bug.
        // `editor/src/extensions.ts` turns it on for the real editor.
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          markdown({ base: markdownLanguage }),
        ],
      }),
      parent: host,
    });
    forceParsing(view);
    m = { view, host };
    let applied: Transaction | null = null;
    continueListMarkup({
      state: view.state,
      dispatch: (tr) => {
        applied = tr;
      },
    });
    const tr = applied as Transaction | null;
    return tr === null ? view.state.selection : tr.state.selection;
  }

  it("does not drop the caret whose change is not a continuation insert", () => {
    // The shape that produces the mismatch, which took two attempts to write.
    // A caret in plain PROSE does not: upstream still inserts a plain newline
    // there, that text starts with a line break, and it takes the same arm, so
    // the counts match and the bug is invisible. What is needed is a caret
    // whose change carries NO line break at all, and the empty-item arm is one:
    // it deletes the markup instead. So the first caret ends `- a` and
    // continues the list, the second sits on an empty `- ` and clears it, one
    // caret is recorded for two ranges, and the selection used to be rebuilt
    // from the short list with the second cursor simply gone.
    const doc = "- a\n- \n";
    const sel = enterTwice(doc, 3, 6);
    expect(sel.ranges).toHaveLength(2);
  });

  it("still moves BOTH carets when both are on list items", () => {
    // The counts match here, so this takes the per-caret path. It is the case
    // the mismatch branch must not have broken.
    const doc = "- a\n- b";
    const sel = enterTwice(doc, 3, 7);
    expect(sel.ranges).toHaveLength(2);
    // Each caret sits after the marker its own continuation inserted, so
    // neither is where it started.
    expect(sel.ranges[0]!.head).toBeGreaterThan(3);
    expect(sel.ranges[1]!.head).toBeGreaterThan(7);
  });
});
