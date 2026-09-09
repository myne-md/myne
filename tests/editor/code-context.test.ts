// @vitest-environment jsdom
//
// Formatting suppression inside code (MYND-154 task 7): the selection toolbar
// and `toggleWrap` must be inert inside a code node so applying bold/italic
// never injects literal markers into the source.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { assertParsed } from "./_parse-budget";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeNestMarkdownExtension } from "../../src/editor/code-highlight";
import { isSelectionInCode } from "../../src/editor/code-context";
import { toggleWrap } from "../../src/editor/wrap-toggle";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, anchor: number, head: number): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [codeNestMarkdownExtension] }),
      ],
    }),
    parent: host,
  });
  assertParsed(view);
  return { view, host };
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

const FENCED = "```rust\nlet x = 1;\n```"; // body "let x = 1;" starts at offset 8

describe("isSelectionInCode", () => {
  let m: Mounted | null = null;
  afterEach(() => {
    if (m) teardown(m);
    m = null;
  });

  it("is true for a selection inside a fenced code block", () => {
    m = mount(FENCED, 8, 13); // "let x"
    expect(isSelectionInCode(m.view.state)).toBe(true);
  });

  it("is true for a selection inside inline code", () => {
    const doc = "run `npm i` now";
    m = mount(doc, 5, 10); // "npm i"
    expect(isSelectionInCode(m.view.state)).toBe(true);
  });

  it("is false for a selection in plain prose", () => {
    const doc = "hello world here";
    m = mount(doc, 6, 11); // "world"
    expect(isSelectionInCode(m.view.state)).toBe(false);
  });
});

describe("toggleWrap is a no-op inside code", () => {
  let m: Mounted | null = null;
  afterEach(() => {
    if (m) teardown(m);
    m = null;
  });

  it("refuses (returns false, no dispatch) for a selection inside a fenced block", () => {
    m = mount(FENCED, 8, 13);
    const dispatch = vi.fn();
    const handled = toggleWrap("**", "**")({ state: m.view.state, dispatch });
    expect(handled).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    // Document untouched (no `**` injected into the code).
    expect(m.view.state.doc.toString()).toBe(FENCED);
  });

  it("still wraps a selection in ordinary prose", () => {
    m = mount("hello world here", 6, 11);
    const dispatch = vi.fn();
    const handled = toggleWrap("**", "**")({ state: m.view.state, dispatch });
    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
