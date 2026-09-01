// @vitest-environment jsdom
//
// A list item inside a blockquote gets BOTH insets (myne-md/myne#594).
//
// Two line decorations on one line have their `style` attributes concatenated,
// and two declarations of the same property do not compose: the later one wins,
// by extension-registration order, which nothing in either file states. That is
// not a hypothetical. Measured on this exact document, `blockquote.ts` was
// registered after `list.ts` in `decorations/index.ts`, so its
// `padding-left: var(--cm-line-lead)` discarded the list's whole hanging-indent
// calc while the list's negative `text-indent` survived. A quoted list item
// therefore had its marker pulled left of the quote bar with nothing to push it
// back, which is precisely the bug the `inBlockquote()` carve-out used to
// prevent and which replacing that carve-out was supposed to fix.
//
// Every other list test asserts the list's own style string in isolation, where
// the defect is invisible. This file mounts the two extensions together and
// reads the MERGED attribute off the DOM, which is the only place the question
// is decided.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { listDecorations } from "../../src/editor/decorations/list";
import { blockquoteDecorations } from "../../src/editor/decorations/blockquote";

let host: HTMLDivElement | null = null;
let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

/** The style attribute of the first line, as the browser would see it: both
 *  decorations' declarations, in registration order. */
function mergedStyle(doc: string, line = 1): string {
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        listDecorations(),
        blockquoteDecorations(),
      ],
    }),
    parent: host,
  });
  const lines = host.querySelectorAll(".cm-line");
  return lines[line - 1]?.getAttribute("style") ?? "";
}

describe("a list item inside a blockquote", () => {
  it("keeps the list's hanging indent, which folds the quote's lead into it", () => {
    const style = mergedStyle("> - quoted item\n");
    // The list's own declaration survives, and it is the one that reads the
    // quote's published lead. Asserted on the calc rather than on a resolved
    // pixel value because jsdom resolves no custom property.
    expect(style).toContain("padding-left: calc(var(--cm-line-lead, 0px)");
    expect(style).toContain("var(--cm-list-marker-bullet");
    // And the lead itself is published on the same element, so the calc has
    // something to read.
    expect(style).toContain("--cm-line-lead:");
  });

  it("does not leave the negative text-indent without its compensating padding", () => {
    // The failure shape stated directly: the marker is pulled left by the
    // text-indent, and if the padding that pushes the line back is gone, it
    // lands left of the quote bar.
    const style = mergedStyle("> - quoted item\n");
    expect(style).toContain("text-indent: calc(-1 *");
    expect(style).not.toMatch(/padding-left:\s*var\(--cm-line-lead[^)]*\)\s*;/);
  });

  it("still indents a quoted line that is NOT a list", () => {
    // The other half of the split: the quote's inset moved to a `.cm-blockquote`
    // stylesheet rule, so a plain quoted paragraph has to keep getting it. The
    // rule is not readable from the inline attribute, so this asserts the two
    // inputs it needs: the class, and the property it reads.
    const style = mergedStyle("> just a quote\n");
    expect(style).toContain("--cm-line-lead:");
    expect(host!.querySelector(".cm-line")!.className).toContain("cm-blockquote");
    // And no inline `padding-left`, which is what would beat the rule on a list
    // line if it came back.
    expect(style).not.toContain("padding-left");
  });

  it("nests: a deeper quote publishes a larger lead", () => {
    const one = mergedStyle("> - a\n");
    const two = mergedStyle(">> - a\n");
    const lead = (s: string): number =>
      Number(/--cm-line-lead:\s*(\d+)px/.exec(s)?.[1] ?? "-1");
    expect(lead(one)).toBeGreaterThan(0);
    expect(lead(two)).toBeGreaterThan(lead(one));
  });
});
