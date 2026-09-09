// @vitest-environment jsdom
//
// Rendering regressions for the two runtime bugs found on first real-app run
// (MYND-154): (1) code body was monochrome — nested coloring never applied;
// (2) the first body line escaped the card (uncarded white line) because the
// card-top bar's block-replace ran through the next line's start and swallowed
// its line decoration. Both are asserted against the rendered DOM here.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { assertParsed } from "./_parse-budget";
import {
  codeNestMarkdownExtension,
  codeSyntaxHighlighting,
} from "../../src/editor/code-highlight";
import { fencedCodeDecorations } from "../../src/editor/decorations/fenced-code";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length, head: doc.length },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [codeNestMarkdownExtension] }),
        codeSyntaxHighlighting,
        fencedCodeDecorations(),
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

describe("code-block rendering (jsdom)", () => {
  let m: Mounted | null = null;
  afterEach(() => {
    if (m) teardown(m);
    m = null;
  });

  it("bug 2 regression: every body line of an away card is carded (no uncarded first line)", () => {
    m = mount("```rust\nlet a = 1;\nlet b = 2;\nlet c = 3;\n```");
    const lines = [...m.host.querySelectorAll(".cm-line")];
    expect(lines.length).toBe(3); // 3 body lines (fences hidden)
    for (const el of lines) {
      expect(el.className).toContain("cm-code-card-body");
    }
  });

  it("bug 1 regression: code body is syntax-colored (eager packs → synchronous nesting)", () => {
    m = mount("```rust\nlet answer = 42;\n```");
    // eager `support` → the wrap nests on the first parse; drive it to completion
    // (jsdom has no background worker)
    assertParsed(m.view);
    // highlightTree applies CM's generated (ͼ-prefixed) classes to colored tokens
    const colored = [...m.host.querySelectorAll(".cm-content span")].filter((s) =>
      /ͼ/.test(s.className),
    );
    expect(colored.length).toBeGreaterThan(0);
  });
});
