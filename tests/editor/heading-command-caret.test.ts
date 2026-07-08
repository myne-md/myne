// @vitest-environment jsdom
//
// Heading toolbar-command caret placement. The mobile format bar's H1/H2 buttons
// and the desktop selection toolbar both route through `applyHeadingLevel`, so
// this guards the shared behavior: after applying a heading the caret must land
// INSIDE the heading text (right after "# "), never stranded before the marker.
// Regression: pressing H1 on an empty line used to leave the caret at "|# ", so
// the next keystroke landed before the hashes ("text# " instead of "# text").

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorCommands, applyHeadingLevel } from "@myne/editor/toolbar/commands";

function makeView(doc: string, anchor: number, head = anchor): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView({
    parent: host,
    state: EditorState.create({ doc, selection: { anchor, head } }),
  });
}

describe("applyHeadingLevel caret placement", () => {
  it("puts the caret after '# ' on an empty line", () => {
    const v = makeView("", 0);
    editorCommands.heading1(v);
    expect(v.state.doc.toString()).toBe("# ");
    expect(v.state.selection.main.head).toBe(2);
  });

  it("keeps the caret at the same text offset when adding a marker", () => {
    // "he|llo" (offset 2) → "# he|llo" (offset 4 = 2 prefix + 2).
    const v = makeView("hello", 2);
    applyHeadingLevel(v, 1);
    expect(v.state.doc.toString()).toBe("# hello");
    expect(v.state.selection.main.head).toBe(4);
  });

  it("shifts the caret with the marker when changing the level", () => {
    // "# he|llo" (offset 4) → "## he|llo" (offset 5).
    const v = makeView("# hello", 4);
    applyHeadingLevel(v, 2);
    expect(v.state.doc.toString()).toBe("## hello");
    expect(v.state.selection.main.head).toBe(5);
  });

  it("keeps the caret in the text when clearing the marker", () => {
    // "## he|llo" (offset 5) → "he|llo" (offset 2).
    const v = makeView("## hello", 5);
    applyHeadingLevel(v, 0);
    expect(v.state.doc.toString()).toBe("hello");
    expect(v.state.selection.main.head).toBe(2);
  });
});
