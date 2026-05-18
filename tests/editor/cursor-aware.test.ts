// @vitest-environment jsdom
//
// `isCursorLine` + `isInsideRange` tests — covers two cursor-aware fixes
// from this session:
//
// 1. **Focus-loss bug**: sidebar/settings click should make the editor
//    return to rendered "view mode" even though CM6's selection state
//    persists. Both helpers return `false` when `view.hasFocus === false`.
//
// 2. **Per-inline cursor reveal (user request)**: two formatted spans on
//    the same line should NOT both lift their syntax when the cursor is
//    on only one of them. `isInsideRange` returns `true` only when the
//    cursor lies within the decoration's byte range, vs `isCursorLine`'s
//    line-scoped check.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  isCursorLine,
  isInsideRange,
} from "../../src/editor/decorations/cursor-aware";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, selectionPos: number): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: selectionPos, head: selectionPos },
    }),
    parent: host,
  });
  return { view, host };
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

describe("isCursorLine (line-scoped cursor-aware reveal)", () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted !== null) teardown(mounted);
    mounted = null;
  });

  it("returns true when cursor is on the same line as the range", () => {
    const doc = "line one\nline two\nline three\n";
    const lineTwoFrom = doc.indexOf("line two");
    const lineTwoTo = lineTwoFrom + "line two".length;
    mounted = mount(doc, lineTwoFrom + 3);
    mounted.view.focus();
    expect(isCursorLine(mounted.view, lineTwoFrom, lineTwoTo)).toBe(true);
  });

  it("returns false when cursor is on a different line", () => {
    const doc = "line one\nline two\n";
    const lineOneFrom = 0;
    const lineOneTo = "line one".length;
    mounted = mount(doc, doc.indexOf("line two") + 2);
    mounted.view.focus();
    expect(isCursorLine(mounted.view, lineOneFrom, lineOneTo)).toBe(false);
  });

  it("returns false when the editor is not focused (focus-loss bug fix)", () => {
    const doc = "line one\nline two\n";
    const lineTwoFrom = doc.indexOf("line two");
    const lineTwoTo = lineTwoFrom + "line two".length;
    mounted = mount(doc, lineTwoFrom + 3);
    // Do NOT call focus(); blur explicitly.
    mounted.view.contentDOM.blur();
    // Selection still says cursor is on line two, but hasFocus is false
    // → isCursorLine must return false so decorations re-apply.
    expect(mounted.view.hasFocus).toBe(false);
    expect(isCursorLine(mounted.view, lineTwoFrom, lineTwoTo)).toBe(false);
  });
});

describe("isInsideRange (per-inline cursor reveal)", () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted !== null) teardown(mounted);
    mounted = null;
  });

  it("returns true when cursor is inside the byte range", () => {
    const doc = "this is **bold** and *italic* text";
    const boldFrom = doc.indexOf("**bold**");
    const boldTo = boldFrom + "**bold**".length;
    mounted = mount(doc, boldFrom + 4); // inside "bold"
    mounted.view.focus();
    expect(isInsideRange(mounted.view, boldFrom, boldTo)).toBe(true);
  });

  it("returns true at the boundary positions (from + to)", () => {
    const doc = "see **bold** here";
    const from = doc.indexOf("**bold**");
    const to = from + "**bold**".length;
    mounted = mount(doc, from);
    mounted.view.focus();
    expect(isInsideRange(mounted.view, from, to)).toBe(true);

    mounted.view.dispatch({ selection: { anchor: to, head: to } });
    expect(isInsideRange(mounted.view, from, to)).toBe(true);
  });

  it("returns false when cursor is on the same line but outside the range", () => {
    const doc = "this is **bold** and *italic* text";
    const boldFrom = doc.indexOf("**bold**");
    const boldTo = boldFrom + "**bold**".length;
    const italicFrom = doc.indexOf("*italic*");
    // Cursor inside the italic span (different decoration range).
    mounted = mount(doc, italicFrom + 3);
    mounted.view.focus();
    expect(isInsideRange(mounted.view, boldFrom, boldTo)).toBe(false);
  });

  it("returns false when editor not focused", () => {
    const doc = "see **bold** here";
    const from = doc.indexOf("**bold**");
    const to = from + "**bold**".length;
    mounted = mount(doc, from + 4);
    mounted.view.contentDOM.blur();
    expect(mounted.view.hasFocus).toBe(false);
    expect(isInsideRange(mounted.view, from, to)).toBe(false);
  });
});
