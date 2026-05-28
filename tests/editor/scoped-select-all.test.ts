// Frontmatter-aware Cmd/Ctrl+A regression detector (MYND-145).
//
// `scopedSelectAllRange` decides what a select-all should cover based on the
// cursor's section: body-only when in the body, YAML-only when in the
// frontmatter, and `null` (→ CodeMirror's default whole-document selectAll)
// when the note has no line-1-anchored frontmatter. This guards against the
// original bug where a whole-document select + delete silently wiped the
// Myne-managed frontmatter (`title:` / `updated:`).

import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { scopedSelectAllRange } from "../../src/editor/keymap";
import { locateFrontmatter } from "../../src/dialect/lezer/frontmatter";

const FM_DOC = "---\ntitle: Note\nupdated: 2026-05-28\n---\nbody line 1\nbody line 2";

function range(doc: string, head: number) {
  return scopedSelectAllRange(Text.of(doc.split("\n")), head);
}

describe("scopedSelectAllRange — Cmd/Ctrl+A frontmatter scoping", () => {
  it("selects only the body when the cursor is in the body", () => {
    const fm = locateFrontmatter(FM_DOC)!;
    // Cursor somewhere in the body.
    const head = FM_DOC.indexOf("body line 2");
    expect(range(FM_DOC, head)).toEqual({
      anchor: fm.blockEnd,
      head: FM_DOC.length,
    });
  });

  it("selects only the YAML when the cursor is in the frontmatter", () => {
    const fm = locateFrontmatter(FM_DOC)!;
    const head = FM_DOC.indexOf("title:");
    expect(range(FM_DOC, head)).toEqual({
      anchor: fm.bodyStart,
      head: fm.bodyEnd,
    });
  });

  it("treats the first body position (cursor just after the closing fence) as body", () => {
    const fm = locateFrontmatter(FM_DOC)!;
    expect(range(FM_DOC, fm.blockEnd)).toEqual({
      anchor: fm.blockEnd,
      head: FM_DOC.length,
    });
  });

  it("returns null (default selectAll) when there is no frontmatter", () => {
    const doc = "just a plain note\nno frontmatter here";
    expect(range(doc, 5)).toBeNull();
  });

  it("returns null when an opener has no closing fence (not frontmatter per §3.6)", () => {
    const doc = "---\ntitle: dangling\nbody without close";
    expect(range(doc, 0)).toBeNull();
  });

  it("handles frontmatter with an empty body (selecting body is an empty range at EOF)", () => {
    const doc = "---\ntitle: Only FM\n---\n";
    const fm = locateFrontmatter(doc)!;
    // Cursor at end of doc → body section; body is empty.
    expect(range(doc, doc.length)).toEqual({
      anchor: fm.blockEnd,
      head: doc.length,
    });
    // Cursor in the YAML → selects the YAML body between fences.
    expect(range(doc, doc.indexOf("title:"))).toEqual({
      anchor: fm.bodyStart,
      head: fm.bodyEnd,
    });
  });
});
