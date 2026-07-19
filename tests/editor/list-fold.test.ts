// Nested-list folding service (heading-list-folding / MYND-300, task 3, story 3).
//
// Stock @codemirror/lang-markdown's `foldNodeProp` excludes lists (it folds
// headings + multi-line paragraphs/blocks), so list folding is a custom
// `foldService` keyed on lezer `ListItem` nodes with a CHILDREN-ONLY predicate:
// a list item folds only when it has a nested sub-list (spans more than its own
// first line); a flat single-line item is NOT foldable. The fold range
// collapses everything after the item's first line through the end of its last
// descendant line.
//
// The predicate + range live in the pure `listFoldRange(state, from, to)`, so
// these assertions target IT directly (not `foldable()`, which would also
// report the markdown built-in's paragraph/heading folds). One integration
// check confirms the service is wired so `foldable()` surfaces the same range
// for a children-bearing item.

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, foldable } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { listFoldRange, listFoldService } from "../../src/editor/list-fold";

/** A markdown-parsed EditorState with the list-fold service mounted. The docs
 *  here are tiny, but the lezer parse is lazy — `syntaxTree` alone only reads
 *  whatever slice has already been realized, which under CI load/timing can be
 *  the empty root. `ensureSyntaxTree` forces a full synchronous parse to the end
 *  of the doc so the foldService reads a complete tree deterministically. */
function parsed(doc: string): EditorState {
  const s = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage }), listFoldService()],
  });
  ensureSyntaxTree(s, s.doc.length, 5000);
  return s;
}

/** The list-fold range for the line CONTAINING byte offset `at`, or null. */
function listFoldAt(s: EditorState, at: number): { from: number; to: number } | null {
  const line = s.doc.lineAt(at);
  return listFoldRange(s, line.from, line.to);
}

describe("listFoldService — children-only predicate", () => {
  it("a list item WITH nested children is foldable", () => {
    const doc = "- parent\n  - child a\n  - child b\n- flat\n";
    const s = parsed(doc);
    expect(listFoldAt(s, doc.indexOf("parent"))).not.toBeNull();
  });

  it("a FLAT single-line list item is NOT foldable (no fold arrow)", () => {
    const doc = "- parent\n  - child a\n- flat\n";
    const s = parsed(doc);
    expect(listFoldAt(s, doc.indexOf("flat"))).toBeNull();
  });

  it("a nested child that itself has no children is NOT foldable", () => {
    const doc = "- parent\n  - child a\n  - child b\n";
    const s = parsed(doc);
    // `child a` is a leaf list item.
    expect(listFoldAt(s, doc.indexOf("child a"))).toBeNull();
  });

  it("fold range starts at the end of the item's first line", () => {
    const doc = "- parent\n  - child a\n  - child b\n- flat\n";
    const s = parsed(doc);
    const firstLine = s.doc.lineAt(doc.indexOf("parent"));
    const range = listFoldAt(s, doc.indexOf("parent"));
    expect(range!.from).toBe(firstLine.to);
  });

  it("fold range extends to the last descendant line of the item (not the sibling)", () => {
    const doc = "- parent\n  - child a\n  - child b\n- flat\n";
    const s = parsed(doc);
    const range = listFoldAt(s, doc.indexOf("parent"));
    // Ends at `- child b`'s line end, NOT into the sibling `- flat` line.
    const childBLine = s.doc.lineAt(doc.indexOf("child b"));
    expect(range!.to).toBe(childBLine.to);
  });

  it("an ordered-list item with a nested ordered list is foldable to its last descendant", () => {
    const doc = "1. one\n   1. nested\n2. two\n";
    const s = parsed(doc);
    const range = listFoldAt(s, doc.indexOf("one"));
    expect(range).not.toBeNull();
    const nestedLine = s.doc.lineAt(doc.indexOf("nested"));
    expect(range!.to).toBe(nestedLine.to);
  });

  it("a paragraph line is not foldable by THIS service", () => {
    const doc = "just a paragraph\nanother line\n";
    const s = parsed(doc);
    expect(listFoldAt(s, 0)).toBeNull();
  });

  it("integration: foldable() surfaces the list-fold range for a children-bearing item", () => {
    const doc = "- parent\n  - child a\n  - child b\n- flat\n";
    const s = parsed(doc);
    const line = s.doc.lineAt(doc.indexOf("parent"));
    const viaService = listFoldRange(s, line.from, line.to);
    const viaFoldable = foldable(s, line.from, line.to);
    expect(viaFoldable).toEqual(viaService);
  });
});
