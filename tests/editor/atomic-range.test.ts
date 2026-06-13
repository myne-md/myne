// @vitest-environment jsdom
//
// Wikilink chip atomic-range tests (A1-A8).
//
// Per `editor-mvp-baseline` PRD Testing Decisions § Vitest V2.5 stance +
// grill 2026-05-16 Q6 (S2+E3): 8 state-machine tests at the EditorView level
// (using CM6 movement commands which consult `EditorView.atomicRanges`) plus
// 1 jsdom keystroke smoke test in atomic-range-smoke.test.ts.
//
// These assert user-visible behavior:
//   - cursor end position after a movement command,
//   - doc text after a deletion command,
// NOT internal `RangeSet` API state — so CM6 6.x → 7.x transaction-API
// breaking changes won't cascade into false test failures.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  cursorCharLeft,
  cursorCharRight,
  deleteCharBackward,
  selectCharLeft,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { wikilinkChipExtensions } from "../../src/editor/wikilink";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, selectionFrom: number, selectionTo?: number): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: selectionFrom, head: selectionTo ?? selectionFrom },
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: [Wikilink],
        }),
        wikilinkChipExtensions(),
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

describe("Wikilink chip atomic-range (A1-A8)", () => {
  let mounted: Mounted | null = null;
  beforeEach(() => {
    mounted = null;
  });
  afterEach(() => {
    if (mounted !== null) teardown(mounted);
  });

  // A1 — Backspace immediately right of `[[Note]]` deletes the entire
  // chip + delimiters in one keystroke.
  it("A1: Backspace right-of-chip deletes entire wikilink span", () => {
    const doc = "before [[Note]] after";
    const rightOfChip = doc.indexOf("]]") + 2; // position 15
    mounted = mount(doc, rightOfChip);
    deleteCharBackward(mounted.view);
    expect(mounted.view.state.doc.toString()).toBe("before  after");
  });

  // §10 / `[[` picker: an EMPTY `[[]]` is plain text, NOT an atomic chip — the
  // cursor edits it freely (in-progress picker text stays editable; backspace
  // removes one char, not the whole span). MYND-38 fix.
  it("empty [[]] is not atomic — backspace deletes one bracket", () => {
    const doc = "x [[]] y";
    const rightOfEmpty = doc.indexOf("]]") + 2;
    mounted = mount(doc, rightOfEmpty);
    deleteCharBackward(mounted.view);
    expect(mounted.view.state.doc.toString()).toBe("x [[] y");
  });

  // A2 — ArrowLeft from immediately right of `[[Note]]` jumps cursor to
  // immediately left of the chip in a single keystroke (no intermediate
  // stop inside `[[Note]]`).
  it("A2: ArrowLeft right-of-chip jumps to left edge of chip", () => {
    const doc = "before [[Note]] after";
    const rightOfChip = doc.indexOf("]]") + 2;
    const leftOfChip = doc.indexOf("[[");
    mounted = mount(doc, rightOfChip);
    cursorCharLeft(mounted.view);
    expect(mounted.view.state.selection.main.head).toBe(leftOfChip);
  });

  // A3 — ArrowRight from immediately left of `[[Note]]` jumps cursor to
  // immediately right of the chip in a single keystroke.
  it("A3: ArrowRight left-of-chip jumps to right edge of chip", () => {
    const doc = "before [[Note]] after";
    const leftOfChip = doc.indexOf("[[");
    const rightOfChip = doc.indexOf("]]") + 2;
    mounted = mount(doc, leftOfChip);
    cursorCharRight(mounted.view);
    expect(mounted.view.state.selection.main.head).toBe(rightOfChip);
  });

  // A4 — Extending selection leftward from immediately right of the chip
  // into the chip snaps the selection head to the outer-left chip boundary
  // (no partial-chip selection state).
  it("A4: selection extension into chip snaps to outer chip boundary", () => {
    const doc = "before [[Note]] after";
    const rightOfChip = doc.indexOf("]]") + 2;
    const leftOfChip = doc.indexOf("[[");
    mounted = mount(doc, rightOfChip);
    selectCharLeft(mounted.view);
    // Selection head should be at leftOfChip (atomic-range skipped over).
    expect(mounted.view.state.selection.main.head).toBe(leftOfChip);
    expect(mounted.view.state.selection.main.anchor).toBe(rightOfChip);
  });

  // A5 — Adjacent chips `[[A]][[B]]` behave as two separate atoms. Cursor
  // between them is a valid stop: ArrowLeft from right-of-B lands at the
  // gap (right-of-A / left-of-B), then ArrowLeft again jumps over A.
  it("A5: adjacent chips behave as two distinct atoms", () => {
    const doc = "before [[A]][[B]] after";
    const rightOfB = doc.indexOf("[[B]]") + "[[B]]".length;
    const gap = doc.indexOf("[[B]]");
    const leftOfA = doc.indexOf("[[A]]");
    mounted = mount(doc, rightOfB);
    cursorCharLeft(mounted.view);
    expect(mounted.view.state.selection.main.head).toBe(gap);
    cursorCharLeft(mounted.view);
    expect(mounted.view.state.selection.main.head).toBe(leftOfA);
  });

  // A6 — `![[Embed]]` chip is atomic, same treatment as `[[Note]]`.
  it("A6: embed chip ![[...]] is atomic", () => {
    const doc = "before ![[Embed]] after";
    const rightOfChip = doc.indexOf("]]") + 2;
    mounted = mount(doc, rightOfChip);
    deleteCharBackward(mounted.view);
    expect(mounted.view.state.doc.toString()).toBe("before  after");
  });

  // A7 — `[[path|Display]]` alias-chip is atomic across the whole span
  // (the pipe `|` does NOT split the atom).
  it("A7: alias-chip [[path|Display]] is atomic across full span", () => {
    const doc = "before [[path/to/note.md|Display]] after";
    const rightOfChip = doc.indexOf("]]") + 2;
    const leftOfChip = doc.indexOf("[[");
    mounted = mount(doc, rightOfChip);
    cursorCharLeft(mounted.view);
    expect(mounted.view.state.selection.main.head).toBe(leftOfChip);
  });

  // A8 — `[[Note#Heading]]` and `[[Note^block-id]]` anchor-chips are
  // atomic across the whole `[[...]]` span (the `#` / `^` doesn't split).
  it("A8a: heading-anchored chip [[Note#Heading]] is atomic across full span", () => {
    const doc = "before [[Note#Heading]] after";
    const rightOfChip = doc.indexOf("]]") + 2;
    const leftOfChip = doc.indexOf("[[");
    mounted = mount(doc, rightOfChip);
    cursorCharLeft(mounted.view);
    expect(mounted.view.state.selection.main.head).toBe(leftOfChip);
  });

  it("A8b: block-id chip [[Note^block-id]] is atomic across full span", () => {
    const doc = "before [[Note^block-id]] after";
    const rightOfChip = doc.indexOf("]]") + 2;
    mounted = mount(doc, rightOfChip);
    deleteCharBackward(mounted.view);
    expect(mounted.view.state.doc.toString()).toBe("before  after");
  });
});
