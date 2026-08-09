// Slash menu trigger-context regression detector.
//
// PRD `editor-mvp-baseline` story 33 — `/` typed inside a fenced code block,
// inline link URL portion, or wikilink range must NOT open the slash menu
// (it's content there).
//
// State-machine test: builds an `EditorState` with the parser extensions,
// places the cursor inside each suppression context, calls
// `isSlashSuppressed` and asserts `true`. Also asserts `false` for
// legitimate trigger positions (line start, after whitespace in body text).

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { isSlashSuppressed } from "../../src/editor/slash/plugin";

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      markdown({
        base: markdownLanguage,
        extensions: [Wikilink],
      }),
    ],
  });
}

describe("Slash menu trigger-context suppression", () => {
  it("body text at line start → NOT suppressed (slash menu opens)", () => {
    const state = makeState("hello\n");
    // Position 0 is the line start.
    expect(isSlashSuppressed(state, 0)).toBe(false);
  });

  it("body text after whitespace → NOT suppressed", () => {
    const state = makeState("hello world\n");
    // Position 6 is right after the space.
    expect(isSlashSuppressed(state, 6)).toBe(false);
  });

  it("inside fenced code block → suppressed", () => {
    const doc = "```ts\nconst x = 1;\n```\n";
    const state = makeState(doc);
    // Position 11 is inside the fenced code (between `t x = 1`).
    expect(isSlashSuppressed(state, 11)).toBe(true);
  });

  it("inside inline code → suppressed", () => {
    const doc = "use `array.map()` here\n";
    const state = makeState(doc);
    // Position 8 is inside `array.map()`.
    expect(isSlashSuppressed(state, 8)).toBe(true);
  });

  it("inside inline link URL → suppressed", () => {
    const doc = "click [here](https://example.com/path)\n";
    const state = makeState(doc);
    // Position 25 is inside the URL "https://example.com/path".
    expect(isSlashSuppressed(state, 25)).toBe(true);
  });

  it("inside wikilink range → suppressed", () => {
    const doc = "see [[Note Title]]\n";
    const state = makeState(doc);
    // Position 10 is inside `[[Note Title]]`.
    expect(isSlashSuppressed(state, 10)).toBe(true);
  });

  it("inside embed wikilink → suppressed", () => {
    const doc = "embed ![[image.png]]\n";
    const state = makeState(doc);
    // Position 12 is inside `![[image.png]]`.
    expect(isSlashSuppressed(state, 12)).toBe(true);
  });

  // myne#407 — the caret ONE position past a suppressed node must NOT be
  // suppressed. `iterate` used to enter a node ending exactly at `pos-1`, so the
  // first caret position after a wikilink / inline code / fenced block was
  // wrongly treated as inside it, killing the trigger for one character. The
  // containment guard (`node.to > pos`) rejects the just-left node.

  it("start of the line after a wikilink → NOT suppressed", () => {
    // `[[Note]]` is [0,8); the next line begins at 9.
    const state = makeState("[[Note]]\n");
    expect(isSlashSuppressed(state, 9)).toBe(false);
  });

  it("after a space that follows a wikilink → NOT suppressed", () => {
    // `[[Note]]` is [0,8), a space at 8, body at 9.
    const state = makeState("[[Note]] x\n");
    expect(isSlashSuppressed(state, 9)).toBe(false);
  });

  it("after a space that follows inline code → NOT suppressed", () => {
    // `` `x` `` is [0,3), a space at 3, body at 4.
    const state = makeState("`x` y\n");
    expect(isSlashSuppressed(state, 4)).toBe(false);
  });

  it("start of the line after a closing fence → NOT suppressed", () => {
    // "```ts\nx\n```\n" — the fenced block ends before the trailing newline at
    // 11; position 12 is the start of the (empty) line after it.
    const state = makeState("```ts\nx\n```\n");
    expect(isSlashSuppressed(state, 12)).toBe(false);
  });

  it("still suppressed one position INSIDE a node's right edge", () => {
    // Guard against over-correcting: the last content char of `[[Note]]` (`]`
    // at index 7) is still inside the node, so a `/` there stays suppressed.
    const state = makeState("[[Note]]\n");
    expect(isSlashSuppressed(state, 7)).toBe(true);
  });
});
