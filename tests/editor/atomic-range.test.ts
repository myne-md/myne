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
  selectAll,
  selectCharLeft,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { wikilinkChipExtensions } from "../../src/editor/wikilink";
import { frontmatterDecorations } from "../../src/editor/decorations/frontmatter";

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

// Frontmatter Properties block atomic-range (MYND-608). The block-replace over
// the frontmatter source used to contribute NO atomicRanges, so cursor motion /
// selection / Backspace could enter the hidden YAML (folder:/updated:) — two
// silent-corruption paths. These pin the same atomic behaviour the wikilink
// suite above verifies for the chip, but for the Properties block.

function mountFm(doc: string, selectionFrom: number): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: selectionFrom },
      // The range is located by a raw doc scan (`cachedLocateFrontmatter`), not
      // the syntax tree, so a bare markdown base is enough.
      extensions: [markdown({ base: markdownLanguage }), frontmatterDecorations()],
    }),
    parent: host,
  });
  return { view, host };
}

/** The single frontmatter atomic range currently registered on the view — read
 *  from the real `atomicRanges` facet so the assertions don't hard-code offsets. */
function fmAtomicRange(view: EditorView): { from: number; to: number } {
  let out: { from: number; to: number } | null = null;
  for (const provider of view.state.facet(EditorView.atomicRanges)) {
    const iter = provider(view).iter();
    while (iter.value !== null) {
      out = { from: iter.from, to: iter.to };
      iter.next();
    }
  }
  if (out === null) throw new Error("no frontmatter atomic range registered");
  return out;
}

const FM_DOC = "---\nfolder: work/\nupdated: 2026-01-01\n---\nbody text";
// Same, but with a BLANK line between the closing `---` and the body — the case
// that reproduced in-app: the caret clamped onto that blank line rendered at the
// block's edge (coordsAtPos fell back to the panel rect). The caret floor must
// skip it and land on the first line with content.
const FM_DOC_BLANK =
  "---\nfolder: work/\nupdated: 2026-01-01\n---\n\nbody text";

// MYND-608 / #209: atomicRanges alone still let the caret park at the block's
// outer edge (offset 0 — visually the TOP of the Properties panel, so ArrowUp
// landed "in" the panel) and let a selection span the whole block (drawSelection
// painted a band up across the panel). A selection guard now clamps every caret/
// selection endpoint to the first body offset (`to`), so the frontmatter is
// wholly unreachable. `to` is the boundary; the YAML lives at [0, to).
describe("Frontmatter Properties selection guard (MYND-608 / #209)", () => {
  let mounted: Mounted | null = null;
  beforeEach(() => {
    mounted = null;
  });
  afterEach(() => {
    if (mounted !== null) teardown(mounted);
  });

  it("FM1: a caret dispatched inside the hidden YAML is clamped to the first body offset", () => {
    mounted = mountFm(FM_DOC, FM_DOC.length);
    const { from, to } = fmAtomicRange(mounted.view);
    const insideYaml = Math.floor((from + to) / 2);
    mounted.view.dispatch({ selection: { anchor: insideYaml } });
    expect(mounted.view.state.selection.main.head).toBe(to);
    expect(mounted.view.state.selection.main.empty).toBe(true);
    // The clamped caret associates FORWARD so it renders at the body line start,
    // not at the block widget's trailing (right) edge.
    expect(mounted.view.state.selection.main.assoc).toBe(1);
  });

  it("FM2: ArrowLeft at the top of the body cannot move the caret into the panel", () => {
    mounted = mountFm(FM_DOC, FM_DOC.length);
    const { to } = fmAtomicRange(mounted.view);
    mounted.view.dispatch({ selection: { anchor: to } }); // start of the body
    cursorCharLeft(mounted.view);
    expect(mounted.view.state.selection.main.head).toBe(to);
  });

  it("FM3: shift-ArrowLeft at the top of the body selects nothing into the frontmatter", () => {
    mounted = mountFm(FM_DOC, FM_DOC.length);
    const { to } = fmAtomicRange(mounted.view);
    mounted.view.dispatch({ selection: { anchor: to } });
    selectCharLeft(mounted.view);
    expect(mounted.view.state.selection.main.empty).toBe(true);
    expect(mounted.view.state.selection.main.head).toBe(to);
  });

  it("FM4: select-all excludes the frontmatter block (body only)", () => {
    mounted = mountFm(FM_DOC, FM_DOC.length);
    const { to } = fmAtomicRange(mounted.view);
    selectAll(mounted.view);
    expect(mounted.view.state.selection.main.from).toBe(to);
    expect(mounted.view.state.selection.main.to).toBe(
      mounted.view.state.doc.length,
    );
  });

  it("FM5: Backspace at the top of the body removes the frontmatter as a unit, never a partial char", () => {
    mounted = mountFm(FM_DOC, FM_DOC.length);
    const { to } = fmAtomicRange(mounted.view);
    mounted.view.dispatch({ selection: { anchor: to } });
    deleteCharBackward(mounted.view);
    const after = mounted.view.state.doc.toString();
    // The frontmatter is gone as a unit — not partially mangled into invalid YAML.
    expect(after).not.toContain("folder:");
    expect(after).not.toContain("updated:");
    expect(after.startsWith("---")).toBe(false);
    expect(after).toContain("body text");
  });

  it("FM6: the widget + its inputs and add button still render with the guard present", () => {
    mounted = mountFm(FM_DOC, FM_DOC.length);
    const panel = mounted.host.querySelector(".cm-fm-properties");
    expect(panel, "Properties panel renders").not.toBeNull();
    expect(panel!.querySelector("input"), "an editable field renders").not.toBeNull();
    expect(
      panel!.querySelector(".cm-fm-properties-add"),
      "the + Add property button renders",
    ).not.toBeNull();
  });

  it("FM7: the caret floor skips a blank line right after the frontmatter, landing on the first body line", () => {
    mounted = mountFm(FM_DOC_BLANK, FM_DOC_BLANK.length);
    const blankLine = mounted.view.state.doc.line(5); // the empty line after ---
    const bodyLine = mounted.view.state.doc.line(6); // "body text"
    expect(blankLine.text).toBe("");
    expect(bodyLine.text).toBe("body text");
    // Try to land the caret on the blank line — it must snap forward to the body
    // line (where the caret can render), never onto the blank line at the block edge.
    mounted.view.dispatch({ selection: { anchor: blankLine.from } });
    expect(mounted.view.state.selection.main.head).toBe(bodyLine.from);
    expect(mounted.view.state.selection.main.empty).toBe(true);
  });
});
