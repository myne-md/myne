// @vitest-environment jsdom
//
// Spell-check decoration pure cores (MYND-264 t3-t4): word extraction with the
// SYNC-3 skip rules + the mark builder with SYNC-9 cursor suppression.

import { describe, expect, it } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { assertParsed } from "./_parse-budget";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { InlineTag } from "../../src/dialect/lezer/inline-tag";
import { codeNestMarkdownExtension } from "../../src/editor/code-highlight";
import {
  extractSpellableWords,
  buildSpellDecorations,
  type SpellRange,
} from "../../src/editor/decorations/spell";

function mount(doc: string, anchor = 0, head = 0): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: [Wikilink, InlineTag, codeNestMarkdownExtension],
        }),
      ],
    }),
    parent: host,
  });
  assertParsed(view);
  return view;
}

describe("extractSpellableWords (SYNC-3)", () => {
  it("extracts prose words with document ranges", () => {
    const v = mount("Here is proseword here.");
    const words = extractSpellableWords(v.state, 0, v.state.doc.length);
    const texts = words.map((w) => w.word);
    expect(texts).toContain("proseword");
    // Ranges map back to the exact substring.
    const w = words.find((x) => x.word === "proseword")!;
    expect(v.state.sliceDoc(w.from, w.to)).toBe("proseword");
  });

  it("skips inline code, #tags, and wikilink targets", () => {
    const v = mount("ok `codeword` #tagword [[Targetword]] done");
    const texts = extractSpellableWords(v.state, 0, v.state.doc.length).map(
      (w) => w.word,
    );
    expect(texts).toContain("ok");
    expect(texts).toContain("done");
    expect(texts).not.toContain("codeword");
    expect(texts).not.toContain("tagword");
    expect(texts).not.toContain("Targetword");
  });

  it("checks wikilink alias (display) text", () => {
    const v = mount("see [[Target|Displayword]] now");
    const texts = extractSpellableWords(v.state, 0, v.state.doc.length).map(
      (w) => w.word,
    );
    expect(texts).toContain("Displayword");
  });

  it("skips pure-number tokens", () => {
    const v = mount("year 2026 word");
    const texts = extractSpellableWords(v.state, 0, v.state.doc.length).map(
      (w) => w.word,
    );
    expect(texts).toContain("year");
    expect(texts).toContain("word");
    expect(texts).not.toContain("2026");
  });
});

describe("buildSpellDecorations (SYNC-9)", () => {
  function range(v: EditorView, word: string): SpellRange {
    const from = v.state.doc.toString().indexOf(word);
    return { word, from, to: from + word.length };
  }

  it("marks each misspelled range", () => {
    const doc = "alpha bravo charlie";
    // Cursor parked in the middle word "bravo" so it suppresses neither
    // alpha nor charlie (the two ranges under test).
    const cursorAt = doc.indexOf("bravo");
    const v = mount(doc, cursorAt, cursorAt);
    const ranges = [range(v, "alpha"), range(v, "charlie")];
    const deco = buildSpellDecorations(v.state, ranges);
    expect(deco.size).toBe(2);
  });

  it("suppresses the mark on the word the cursor is inside", () => {
    const doc = "alpha bravo charlie";
    const cursorAt = doc.indexOf("bravo") + 2; // inside "bravo"
    const v = mount(doc, cursorAt, cursorAt);
    const ranges = [range(v, "alpha"), range(v, "bravo"), range(v, "charlie")];
    const deco = buildSpellDecorations(v.state, ranges);
    // "bravo" suppressed → only alpha + charlie marked.
    expect(deco.size).toBe(2);
  });
});
