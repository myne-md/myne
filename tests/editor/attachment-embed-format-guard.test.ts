// Inline attachment embeds are atomic image/PDF widgets — not text. These
// tests pin the guard that makes the inline-format commands (and, via the same
// predicate, the selection toolbar) treat an embed as non-formattable: you
// cannot bold / italic / strike an `![[att:…]]` embed (MYND-164 dogfooding
// polish). `atomicRanges` only blocks the caret from entering an embed; a
// mouse-drag selection can still span it and `toggleWrap` operates on the raw
// source, so the guard lives in `toggleWrap`'s AST-aware refuse block.

import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { rangeOverlapsAttachmentEmbed } from "../../src/editor/decorations/attachment-embed";
import { toggleWrap } from "../../src/editor/wrap-toggle";

const ID = "a".repeat(64);

function stateWith(doc: string, anchor: number, head: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [markdown({ base: markdownLanguage, extensions: [Wikilink] })],
  });
  // Force a complete parse so syntaxTree() sees the Wikilink node.
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

/** Run a StateCommand against `state`, capturing any dispatched transaction. */
function run(
  state: EditorState,
  cmd: ReturnType<typeof toggleWrap>,
): { handled: boolean; tr: Transaction | null } {
  let tr: Transaction | null = null;
  const handled = cmd({ state, dispatch: (t) => (tr = t) });
  return { handled, tr };
}

const DOC = `ab ![[att:${ID}|p.png]] cd`;
const EMBED_FROM = DOC.indexOf("![[");
const EMBED_TO = DOC.indexOf("]]") + 2;

describe("rangeOverlapsAttachmentEmbed", () => {
  it("is true when the selection exactly covers the embed", () => {
    const state = stateWith(DOC, EMBED_FROM, EMBED_TO);
    expect(rangeOverlapsAttachmentEmbed(state, EMBED_FROM, EMBED_TO)).toBe(true);
  });

  it("is true when the selection spans text + the embed", () => {
    const state = stateWith(DOC, 0, EMBED_TO);
    expect(rangeOverlapsAttachmentEmbed(state, 0, EMBED_TO)).toBe(true);
  });

  it("is false for a text-only selection that does not reach the embed", () => {
    const state = stateWith(DOC, 0, 2); // "ab"
    expect(rangeOverlapsAttachmentEmbed(state, 0, 2)).toBe(false);
  });

  it("is false when the selection merely abuts the embed's left edge", () => {
    const state = stateWith(DOC, 0, EMBED_FROM); // "ab " up to but not into the embed
    expect(rangeOverlapsAttachmentEmbed(state, 0, EMBED_FROM)).toBe(false);
  });
});

describe("toggleWrap refuses to format an attachment embed", () => {
  it("bold is a silent no-op when the selection covers the embed", () => {
    const state = stateWith(DOC, EMBED_FROM, EMBED_TO);
    const { handled, tr } = run(state, toggleWrap("**", "**"));
    expect(handled).toBe(false);
    expect(tr).toBeNull();
  });

  it("italic is a silent no-op when the selection spans text + the embed", () => {
    const state = stateWith(DOC, 0, EMBED_TO);
    const { handled, tr } = run(state, toggleWrap("*", "*"));
    expect(handled).toBe(false);
    expect(tr).toBeNull();
  });

  it("still wraps a plain-text selection that does not touch an embed", () => {
    const state = stateWith(DOC, 0, 2); // "ab"
    const { handled, tr } = run(state, toggleWrap("**", "**"));
    expect(handled).toBe(true);
    expect(tr).not.toBeNull();
    expect(tr!.newDoc.toString()).toContain("**ab**");
    // The embed source is untouched.
    expect(tr!.newDoc.toString()).toContain(`![[att:${ID}|p.png]]`);
  });
});
