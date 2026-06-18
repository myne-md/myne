// @vitest-environment jsdom
//
// Editor keymap bindings (`editor/keymap.ts`, PRD editor-mvp-baseline stories
// 41-46). Two layers:
//   - `scopedSelectAllRange` — the PURE Mod-a frontmatter-scoping helper
//     (MYND-145): cursor in FM → select YAML body only; cursor in body → select
//     body only; no frontmatter → null (fall through to default selectAll).
//   - the `myneKeyBindings` table — assert each binding's `run` command mutates a
//     live view the way the comment promises (wrap toggles, heading cycle, list
//     prefix toggles). These guard against a binding being re-pointed at the
//     wrong command.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView, type Command, type KeyBinding } from "@codemirror/view";
import { foldedRanges, forceParsing, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeNestMarkdownExtension } from "../../src/editor/code-highlight";
import { myneFolding } from "../../src/editor/folding";
import { myneKeyBindings, scopedSelectAllRange } from "../../src/editor/keymap";

const FM = "---\ntitle: Note\nupdated: 2026-01-01\n---\nBody line one\nBody two\n";

describe("scopedSelectAllRange (MYND-145)", () => {
  it("returns null when the doc has no frontmatter (default selectAll)", () => {
    const doc = Text.of(["plain body", "no yaml here"]);
    expect(scopedSelectAllRange(doc, 3)).toBeNull();
  });

  it("cursor in the body → selects the body only (not the YAML)", () => {
    const doc = Text.of(FM.split("\n"));
    const bodyPos = FM.indexOf("Body line one") + 2;
    const sel = scopedSelectAllRange(doc, bodyPos);
    expect(sel).not.toBeNull();
    // Selection starts at/after the frontmatter close, never at offset 0.
    expect(sel!.anchor).toBeGreaterThan(0);
    expect(sel!.head).toBe(doc.length);
    // The selected slice must NOT contain the YAML keys.
    const slice = doc.sliceString(sel!.anchor, sel!.head);
    expect(slice).not.toContain("title:");
    expect(slice).toContain("Body line one");
  });

  it("cursor inside the frontmatter → selects the YAML body only (not the doc body)", () => {
    const doc = Text.of(FM.split("\n"));
    const fmPos = FM.indexOf("title:") + 1;
    const sel = scopedSelectAllRange(doc, fmPos);
    expect(sel).not.toBeNull();
    const slice = doc.sliceString(sel!.anchor, sel!.head);
    expect(slice).toContain("title: Note");
    expect(slice).not.toContain("Body line one");
  });
});

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, anchor: number, head = anchor): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [codeNestMarkdownExtension] }),
        // Folding extensions so foldAll/unfoldAll have a fold state to drive.
        myneFolding(),
        // Multi-cursor (MYND-306): selectNextOccurrence only adds a second range
        // when the facet is on — mirror the production enablement here.
        EditorState.allowMultipleSelections.of(true),
      ],
    }),
    parent: host,
  });
  forceParsing(view);
  syntaxTree(view.state);
  return { view, host };
}

/** Count folded ranges in the view's state. */
function foldedCount(view: EditorView): number {
  let n = 0;
  foldedRanges(view.state).between(0, view.state.doc.length, () => {
    n++;
  });
  return n;
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

function binding(key: string): KeyBinding {
  const b = myneKeyBindings.find((k) => k.key === key);
  if (b === undefined) throw new Error(`no binding for ${key}`);
  return b;
}

function run(key: string, view: EditorView): boolean {
  const cmd = binding(key).run as Command;
  return cmd(view);
}

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

describe("myneKeyBindings — wrap commands", () => {
  it("Mod-b wraps the selection in bold", () => {
    m = mount("hello world", 0, 5);
    expect(run("Mod-b", m.view)).toBe(true);
    expect(m.view.state.doc.toString()).toBe("**hello** world");
  });

  it("Mod-i wraps the selection in italic", () => {
    m = mount("hello world", 0, 5);
    expect(run("Mod-i", m.view)).toBe(true);
    expect(m.view.state.doc.toString()).toBe("*hello* world");
  });

  it("Mod-e wraps the selection in inline code", () => {
    m = mount("hello world", 0, 5);
    expect(run("Mod-e", m.view)).toBe(true);
    expect(m.view.state.doc.toString()).toBe("`hello` world");
  });
});

describe("myneKeyBindings — heading cycle (Mod-Shift-h)", () => {
  it("cycles paragraph → H1 on the cursor line", () => {
    m = mount("a title", 2);
    run("Mod-Shift-h", m.view);
    expect(m.view.state.doc.toString()).toBe("# a title");
  });

  it("cycles H1 → H2 (replaces the level, never stacks #)", () => {
    m = mount("# a title", 3);
    run("Mod-Shift-h", m.view);
    expect(m.view.state.doc.toString()).toBe("## a title");
  });

  it("wraps H6 → paragraph (level 6 + 1 mod 7 = 0)", () => {
    m = mount("###### a title", 8);
    run("Mod-Shift-h", m.view);
    expect(m.view.state.doc.toString()).toBe("a title");
  });
});

describe("myneKeyBindings — list prefix toggles", () => {
  it("Mod-Shift-8 adds a `- ` bullet prefix, and a second press removes it", () => {
    m = mount("item one", 0);
    run("Mod-Shift-8", m.view);
    expect(m.view.state.doc.toString()).toBe("- item one");
    run("Mod-Shift-8", m.view);
    expect(m.view.state.doc.toString()).toBe("item one");
  });

  it("Mod-Shift-7 adds a `1. ` ordered prefix", () => {
    m = mount("item one", 0);
    run("Mod-Shift-7", m.view);
    expect(m.view.state.doc.toString()).toBe("1. item one");
  });

  it("Mod-Shift-m adds a `- [ ] ` task prefix", () => {
    m = mount("buy milk", 0);
    run("Mod-Shift-m", m.view);
    expect(m.view.state.doc.toString()).toBe("- [ ] buy milk");
  });

  it("a list toggle spanning a multi-line selection prefixes every line", () => {
    const doc = "one\ntwo\nthree";
    m = mount(doc, 0, doc.length); // select all three lines
    run("Mod-Shift-8", m.view);
    expect(m.view.state.doc.toString()).toBe("- one\n- two\n- three");
  });
});

describe("myneKeyBindings — fold all / unfold all (MYND-300)", () => {
  it("binds Mod-Alt-[ and Mod-Alt-] to commands", () => {
    // The chords are present and distinct from the reserved set.
    expect(myneKeyBindings.some((b) => b.key === "Mod-Alt-[")).toBe(true);
    expect(myneKeyBindings.some((b) => b.key === "Mod-Alt-]")).toBe(true);
  });

  it("Mod-Alt-[ folds, Mod-Alt-] unfolds a multi-heading doc", () => {
    m = mount("# A\nbody a\n## A.1\nchild\n# B\nbody b\n", 0);
    expect(foldedCount(m.view)).toBe(0);
    expect(run("Mod-Alt-[", m.view)).toBe(true);
    expect(foldedCount(m.view)).toBeGreaterThan(0);
    expect(run("Mod-Alt-]", m.view)).toBe(true);
    expect(foldedCount(m.view)).toBe(0);
  });
});

describe("myneKeyBindings — Mod-d selectNextOccurrence (multi-cursor, MYND-306)", () => {
  it("binds Mod-d explicitly (no searchKeymap wholesale install)", () => {
    expect(myneKeyBindings.some((b) => b.key === "Mod-d")).toBe(true);
  });

  it("Mod-d on a selected word adds the next occurrence to the multi-selection", () => {
    // Select the first "cat"; Mod-d extends to the second "cat".
    m = mount("cat dog cat", 0, 3);
    expect(m.view.state.selection.ranges.length).toBe(1);
    expect(run("Mod-d", m.view)).toBe(true);
    expect(m.view.state.selection.ranges.length).toBe(2);
    // Both ranges cover a "cat" occurrence.
    for (const r of m.view.state.selection.ranges) {
      expect(m.view.state.doc.sliceString(r.from, r.to)).toBe("cat");
    }
  });

  it("repeated Mod-d keeps extending across all occurrences", () => {
    m = mount("cat cat cat", 0, 3);
    run("Mod-d", m.view);
    run("Mod-d", m.view);
    expect(m.view.state.selection.ranges.length).toBe(3);
  });
});

describe("myneKeyBindings — Mod-a scoped select-all", () => {
  it("returns false (falls through to default selectAll) with no frontmatter", () => {
    m = mount("plain body text", 4);
    expect(run("Mod-a", m.view)).toBe(false);
  });

  it("selects only the body when the doc has frontmatter", () => {
    m = mount(FM, FM.indexOf("Body line one") + 2);
    expect(run("Mod-a", m.view)).toBe(true);
    const sel = m.view.state.selection.main;
    const slice = m.view.state.doc.sliceString(sel.from, sel.to);
    expect(slice).toContain("Body line one");
    expect(slice).not.toContain("title:");
  });
});
