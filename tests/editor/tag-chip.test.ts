// @vitest-environment jsdom
//
// Inline #tag chip decoration (tag-system #3 / MYND-45). Covers the node→chip
// mapping + byte-stability (mounted view) and the click→entry tag extraction
// (`inlineTagBodyAt`, pure — the click geometry itself is covered by the
// real-browser E2E, jsdom has no layout for posAtDOM).

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { InlineTag } from "../../src/dialect/lezer/inline-tag";
import {
  buildTagChipDecorations,
  inlineTagBodyAt,
  tagChipDecorations,
} from "../../src/editor/decorations/tag-chip";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, selectionPos: number): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: selectionPos, head: selectionPos },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [InlineTag] }),
        tagChipDecorations(),
      ],
    }),
    parent: host,
  });
  return { view, host };
}

/** Count + first label of the chip replace-decorations the builder emits. */
function chipInfo(view: EditorView): { count: number; firstFrom: number } {
  const set = buildTagChipDecorations(view);
  let count = 0;
  let firstFrom = -1;
  const cur = set.iter();
  while (cur.value !== null) {
    if (count === 0) firstFrom = cur.from;
    count++;
    cur.next();
  }
  return { count, firstFrom };
}

describe("inline #tag chip decoration", () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted !== null) {
      mounted.view.destroy();
      mounted.host.remove();
      mounted = null;
    }
  });

  it("chips an off-cursor #tag and never rewrites the document bytes", () => {
    const doc = "see #alpha here\n";
    mounted = mount(doc, 0); // cursor at start, away from the tag
    const { count, firstFrom } = chipInfo(mounted.view);
    expect(count).toBe(1);
    expect(firstFrom).toBe(doc.indexOf("#alpha"));
    // byte-stability (§6 C1): the decoration is replace-only — no transaction.
    expect(mounted.view.state.doc.toString()).toBe(doc);
  });

  it("chips a nested #a/b/c as a single range", () => {
    const doc = "x #a/b/c y\n";
    mounted = mount(doc, 0);
    const { count, firstFrom } = chipInfo(mounted.view);
    expect(count).toBe(1);
    expect(firstFrom).toBe(doc.indexOf("#a/b/c"));
  });
});

describe("inlineTagBodyAt (click→entry mapping)", () => {
  const stateFor = (doc: string) =>
    EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, extensions: [InlineTag] })],
    });

  it("returns the tag body (no leading #) at the tag position", () => {
    const doc = "see #alpha here\n";
    expect(inlineTagBodyAt(stateFor(doc), doc.indexOf("#alpha"))).toBe("alpha");
  });

  it("returns the whole nested path for a nested tag (subtree-inclusive target)", () => {
    const doc = "x #a/b/c y\n";
    expect(inlineTagBodyAt(stateFor(doc), doc.indexOf("#a/b/c"))).toBe("a/b/c");
  });

  it("returns null when the position is not on a tag", () => {
    expect(inlineTagBodyAt(stateFor("no tags here\n"), 0)).toBeNull();
  });
});
