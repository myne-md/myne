// @vitest-environment jsdom
//
// Per-inline cursor-aware reveal — when two formatted spans share a line,
// only the one containing the cursor should lift its decoration. The
// other stays rendered. This is a behavior change from the original
// line-scoped check (`isCursorLine`); the new helper `isInsideRange`
// scopes by decoration byte range.
//
// Test strategy: build the emphasis decoration set for a doc with two
// emphasis nodes on the same line, place the cursor inside one, and
// inspect the resulting DecorationSet to confirm only the un-cursored
// emphasis emits its delimiter-hide replace decorations.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { emphasisDecorations } from "../../src/editor/decorations/emphasis";
import { inlineCodeDecorations } from "../../src/editor/decorations/inline-code";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, selectionPos: number): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: selectionPos, head: selectionPos },
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: [Wikilink],
        }),
        emphasisDecorations(),
        inlineCodeDecorations(),
      ],
    }),
    parent: host,
  });
  return { view, host };
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

describe("Per-inline cursor reveal (isInsideRange-driven)", () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted !== null) teardown(mounted);
    mounted = null;
  });

  it("cursor inside bold only — bold delimiters revealed, italic delimiters still hidden", () => {
    const doc = "this is **bold** and *italic* text\n";
    const boldStart = doc.indexOf("**bold**");
    const italicStart = doc.indexOf("*italic*");
    mounted = mount(doc, boldStart + 4); // inside "bold"
    mounted.view.focus();
    // In jsdom, `.focus()` doesn't always fire a `focusChanged` update on
    // ViewPlugin — re-dispatch the selection to force a decoration rebuild
    // with the current `view.hasFocus` value.
    mounted.view.dispatch({ selection: mounted.view.state.selection });
    mounted.view.requestMeasure();

    // The emphasis decoration emits `Decoration.replace({})` for
    // `EmphasisMark` children when the parent emphasis is OFF-cursor.
    // We assert by inspecting the rendered DOM: the bold delimiters
    // (`**`) should appear as plain text characters in `.cm-line`, while
    // the italic delimiters (`*`) are hidden via the replace decoration.
    const lineText = mounted.view.contentDOM.textContent ?? "";
    // The italic span is OFF-cursor → `*` delimiters hidden.
    // Visible text under italic span: "italic" (no asterisks).
    // Find the position of "italic" in the rendered text.
    expect(lineText).toContain("**bold**"); // bold delimiters visible (cursor in range)
    expect(lineText.includes("*italic*")).toBe(false); // italic delimiters hidden
    expect(lineText).toContain("italic"); // italic content still rendered
    // Position relative to the doc text doesn't matter — using both
    // boldStart and italicStart only to validate string anchoring.
    expect(boldStart).toBeLessThan(italicStart);
  });

  it("cursor inside italic only — italic delimiters revealed, bold hidden", () => {
    const doc = "this is **bold** and *italic* text\n";
    const italicStart = doc.indexOf("*italic*");
    mounted = mount(doc, italicStart + 3); // inside "italic"
    mounted.view.focus();
    // In jsdom, `.focus()` doesn't always fire a `focusChanged` update on
    // ViewPlugin — re-dispatch the selection to force a decoration rebuild
    // with the current `view.hasFocus` value.
    mounted.view.dispatch({ selection: mounted.view.state.selection });
    mounted.view.requestMeasure();
    const lineText = mounted.view.contentDOM.textContent ?? "";
    expect(lineText).toContain("*italic*"); // italic delimiters visible
    expect(lineText.includes("**bold**")).toBe(false); // bold delimiters hidden
    expect(lineText).toContain("bold"); // bold content still rendered
  });

  it("cursor outside both — neither set of delimiters visible", () => {
    const doc = "this is **bold** and *italic* text\n";
    // Park cursor at end of line, well past both inline marks.
    mounted = mount(doc, doc.length - 2);
    mounted.view.focus();
    // In jsdom, `.focus()` doesn't always fire a `focusChanged` update on
    // ViewPlugin — re-dispatch the selection to force a decoration rebuild
    // with the current `view.hasFocus` value.
    mounted.view.dispatch({ selection: mounted.view.state.selection });
    mounted.view.requestMeasure();
    const lineText = mounted.view.contentDOM.textContent ?? "";
    expect(lineText.includes("**bold**")).toBe(false);
    expect(lineText.includes("*italic*")).toBe(false);
    expect(lineText).toContain("bold");
    expect(lineText).toContain("italic");
  });

  it("editor unfocused — all delimiters hidden regardless of selection", () => {
    const doc = "this is **bold** and *italic* text\n";
    const boldStart = doc.indexOf("**bold**");
    mounted = mount(doc, boldStart + 4);
    mounted.view.contentDOM.blur();
    mounted.view.dispatch({ selection: mounted.view.state.selection });
    mounted.view.requestMeasure();
    expect(mounted.view.hasFocus).toBe(false);
    const lineText = mounted.view.contentDOM.textContent ?? "";
    expect(lineText.includes("**bold**")).toBe(false);
    expect(lineText.includes("*italic*")).toBe(false);
  });

  it("inline code on the same line as bold — only one lifts at a time", () => {
    const doc = "use `array.map()` and **bold** here\n";
    const codeStart = doc.indexOf("`array");
    mounted = mount(doc, codeStart + 5);
    mounted.view.focus();
    // In jsdom, `.focus()` doesn't always fire a `focusChanged` update on
    // ViewPlugin — re-dispatch the selection to force a decoration rebuild
    // with the current `view.hasFocus` value.
    mounted.view.dispatch({ selection: mounted.view.state.selection });
    mounted.view.requestMeasure();
    const lineText = mounted.view.contentDOM.textContent ?? "";
    expect(lineText).toContain("`array.map()`"); // code backticks visible
    expect(lineText.includes("**bold**")).toBe(false); // bold delimiters hidden
  });
});
