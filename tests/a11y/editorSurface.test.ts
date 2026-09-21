// @vitest-environment jsdom
//
// The editor surface's accessibility (myne-md/myne#728, task 10).
//
// The editor body's ROLE and `aria-multiline` were already correct: CodeMirror
// sets `role="textbox"` and `aria-multiline="true"` on its content element
// itself (`@codemirror/view`, `updateAttrs`), and `aria-readonly` in a
// read-only state. That half of the task was already true, and the test below
// pins it rather than re-implementing it, because it is a property of a pinned
// dependency and a major bump could take it away silently. The NAME was the
// missing piece and landed in task 4.
//
// What is left is the decoration layer, where three things were wrong in the
// same way: a widget draws something, and what it draws reaches the
// accessibility tree either as noise or not at all.
//
//   - the `==` highlight skin is SYNTAX, read aloud mid-sentence;
//   - a rendered formula is a tree of one-glyph spans, read as glyph soup;
//   - a rendered diagram is a pile of text runs with none of its edges;
//   - a BROKEN wikilink announces exactly like a working one, because the
//     state lived in a CSS class.
//
// And one announcement: folding a section removes a chunk of the document with
// nothing said about it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldEffect, unfoldEffect } from "@codemirror/language";
import { foldAnnouncement, foldAnnounceExtension } from "@myne/editor/fold-announce";
import { mermaidLabel } from "@myne/editor/decorations/mermaid";
import i18n from "../../src/i18n";

/** Comments stripped: these files explain the rule in prose beside the code. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the editor body's role comes from the engine", () => {
  it("CodeMirror still sets role=textbox and aria-multiline on the content element", () => {
    // A property of a pinned dependency. Asserted rather than assumed, because
    // a major bump could drop it and nothing else in this tree would notice.
    const view: string = readFileSync(
      "node_modules/@codemirror/view/dist/index.js",
      "utf8",
    );
    expect(view).toContain('role: "textbox"');
    expect(view).toContain('"aria-multiline": "true"');
    expect(view).toContain('contentAttrs["aria-readonly"] = "true"');
  });
});

describe("decorative widgets are out of the accessibility tree", () => {
  it("the == highlight skin is hidden", () => {
    // It is the SYNTAX, drawn back in only while the cursor sits on the span.
    const src = code("editor/src/decorations/colored-highlight.ts");
    expect(src).toMatch(/cm-hl-eq[\s\S]{0,200}aria-hidden/);
  });

  it("the rendered formula's visual layout is hidden behind a named role=math", () => {
    const src = code("editor/src/decorations/math.ts");
    expect(src).toContain('setAttribute("role", "math")');
    expect(src).toContain('setAttribute("aria-label", this.latex.trim())');
    // The name alone would not be enough: a name does not remove the subtree,
    // so the one-glyph spans would still be walked by a virtual cursor.
    expect(src).toMatch(/visual\.setAttribute\("aria-hidden", "true"\)/);
  });

  it("the KaTeX renderer still emits html only, with the reason recorded", () => {
    // `htmlAndMathml` would put the raw LaTeX (and so a hostile `javascript:`
    // string) into the rendered output, which would mean weakening
    // `tests/editor/math-trust.test.ts`. The trade is written down at the
    // call site; this pins that it was not changed by accident.
    const src = code("editor/src/math/render-math.ts");
    expect(src).toContain('output: "html"');
    expect(src).not.toContain("htmlAndMathml");
  });
});

describe("meaningful widgets carry a label", () => {
  it("names a diagram by its Mermaid kind", () => {
    expect(mermaidLabel("flowchart TD\n  A-->B")).toBe(
      `${i18n.t("editor.a11y.diagram")}: flowchart`,
    );
    expect(mermaidLabel("sequenceDiagram\n  A->>B: hi")).toContain("sequenceDiagram");
  });

  it("skips comments and blank lines when looking for the kind", () => {
    expect(mermaidLabel("\n%% a note\n\ngraph LR\n  A-->B")).toContain("graph");
  });

  it("falls back to the generic word rather than announcing junk", () => {
    // A source starting with a directive or with punctuation has no kind to
    // report, and a label of `%%{init:` is worse than "Diagram".
    for (const source of ["", "%%{init: {}}%%", "   ", "123 not-a-kind"]) {
      expect(mermaidLabel(source), JSON.stringify(source)).toBe(
        i18n.t("editor.a11y.diagram"),
      );
    }
  });

  it("never announces the whole diagram body", () => {
    const body = "flowchart TD\n" + Array.from({ length: 40 }, (_, i) => `  N${i}-->N${i + 1}`).join("\n");
    expect(mermaidLabel(body).length).toBeLessThan(40);
  });

  it("states that a wikilink is broken, which was a CSS class alone", () => {
    const src = code("editor/src/wikilink/chip-widget.ts");
    expect(src).toMatch(/if \(this\.broken\) \{[\s\S]{0,200}aria-label/);
    expect(src).toContain("editor.a11y.brokenLink");
  });
});

describe("folding announces itself", () => {
  it("says which direction, and counts", () => {
    expect(foldAnnouncement(1, 0)).toBe(i18n.t("editor.a11y.sectionFolded", { count: 1 }));
    expect(foldAnnouncement(0, 1)).toBe(i18n.t("editor.a11y.sectionUnfolded", { count: 1 }));
    expect(foldAnnouncement(7, 0)).toContain("7");
  });

  it("says nothing when nothing folded", () => {
    expect(foldAnnouncement(0, 0)).toBeNull();
  });

  it("reports a mixed transaction by what it mostly did, folding on a tie", () => {
    // `foldAll` is one transaction carrying many effects; a toggle-all can
    // carry both directions. Folding wins a tie because it is the direction
    // that HIDES content.
    expect(foldAnnouncement(2, 1)).toContain(i18n.t("editor.a11y.sectionFolded", { count: 2 }));
    expect(foldAnnouncement(1, 2)).toContain(i18n.t("editor.a11y.sectionUnfolded", { count: 2 }));
    expect(foldAnnouncement(1, 1)).toBe(i18n.t("editor.a11y.sectionFolded", { count: 1 }));
  });

  it("attaches the announcement to the transaction that folded", () => {
    // The wiring, not the wording: a `transactionExtender` keeps the
    // announcement atomic with the change, where a plugin reacting afterwards
    // could fire on a transaction that was later filtered out.
    const state = EditorState.create({
      doc: "# a\nbody\n",
      extensions: [foldAnnounceExtension()],
    });
    const tr = state.update({ effects: foldEffect.of({ from: 3, to: 8 }) });
    expect(tr.effects.some((e) => e.is(EditorView.announce))).toBe(true);

    const quiet = state.update({ selection: { anchor: 1 } });
    expect(quiet.effects.some((e) => e.is(EditorView.announce))).toBe(false);
  });

  it("announces an unfold too", () => {
    const state = EditorState.create({
      doc: "# a\nbody\n",
      extensions: [foldAnnounceExtension()],
    });
    const tr = state.update({ effects: unfoldEffect.of({ from: 3, to: 8 }) });
    const announced = tr.effects.find((e) => e.is(EditorView.announce));
    expect(announced?.value).toBe(i18n.t("editor.a11y.sectionUnfolded", { count: 1 }));
  });

  it("announces once for a fold-all, not once per section", () => {
    const state = EditorState.create({
      doc: "# a\nbody\n# b\nbody\n",
      extensions: [foldAnnounceExtension()],
    });
    const tr = state.update({
      effects: [
        foldEffect.of({ from: 3, to: 8 }),
        foldEffect.of({ from: 12, to: 17 }),
      ],
    });
    const announcements = tr.effects.filter((e) => e.is(EditorView.announce));
    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.value).toContain("2");
  });
});
