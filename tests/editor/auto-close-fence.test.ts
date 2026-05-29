// @vitest-environment jsdom
//
// Auto-close fenced code blocks on Enter (MYND-154 task 5).

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeNestMarkdownExtension } from "../../src/editor/code-highlight";
import {
  autoCloseFenceKeymap,
  planAutoCloseFence,
} from "../../src/editor/auto-close-fence";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, anchor: number): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head: anchor },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [codeNestMarkdownExtension] }),
      ],
    }),
    parent: host,
  });
  forceParsing(view);
  return { view, host };
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

describe("planAutoCloseFence", () => {
  let m: Mounted | null = null;
  afterEach(() => {
    if (m) teardown(m);
    m = null;
  });

  it("plans a closer when Enter is pressed at the end of an opening fence (```rust)", () => {
    m = mount("```rust", 7);
    const plan = planAutoCloseFence(m.view.state);
    expect(plan).not.toBeNull();
    expect(plan!.insert).toBe("\n\n```");
    expect(plan!.from).toBe(7);
    expect(plan!.cursor).toBe(8);
  });

  it("plans a closer for a bare opening fence (```)", () => {
    m = mount("```", 3);
    expect(planAutoCloseFence(m.view.state)).not.toBeNull();
  });

  it("does NOT fire when closing an already-open block (no double fence)", () => {
    const doc = "```js\ncode\n```";
    m = mount(doc, doc.length); // cursor at end of the closing ```
    expect(planAutoCloseFence(m.view.state)).toBeNull();
  });

  it("does NOT fire on a non-fence line", () => {
    m = mount("just some prose", 15);
    expect(planAutoCloseFence(m.view.state)).toBeNull();
  });

  it("does NOT fire on inline code (mid-line backticks)", () => {
    const doc = "run `npm i` now";
    m = mount(doc, doc.length);
    expect(planAutoCloseFence(m.view.state)).toBeNull();
  });

  it("does NOT fire when the cursor is not at the end of the fence line", () => {
    m = mount("```rust", 3); // caret right after the backticks, before "rust"
    expect(planAutoCloseFence(m.view.state)).toBeNull();
  });
});

describe("auto-close Enter command (integration)", () => {
  let m: Mounted | null = null;
  afterEach(() => {
    if (m) teardown(m);
    m = null;
  });

  it("inserts the closing fence and lands the cursor on the empty body line", () => {
    m = mount("```rust", 7);
    const run = autoCloseFenceKeymap[0]!.run!;
    const handled = run(m.view);
    expect(handled).toBe(true);
    expect(m.view.state.doc.toString()).toBe("```rust\n\n```");
    expect(m.view.state.selection.main.head).toBe(8); // start of the empty body line
  });

  it("falls through (returns false) on a plain line so the default newline runs", () => {
    m = mount("hello", 5);
    const run = autoCloseFenceKeymap[0]!.run!;
    expect(run(m.view)).toBe(false);
  });
});
