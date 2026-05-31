// Footnote MarkdownConfig — parser-level node-emission tests (MYND-153, task 1).
//
// Asserts the config emits distinguishable FootnoteReference (inline) and
// FootnoteDefinition (block) nodes with locatable FootnoteMark / FootnoteLabel
// children, handles integer and non-integer ids, and never mutates bytes.

import { describe, expect, it } from "vitest";
import { parser } from "../../src/dialect/lezer/parser";
import { Footnote } from "../../src/dialect/lezer/footnote";

interface NodeRec {
  name: string;
  from: number;
  to: number;
  text: string;
}

/** Flat list of every node in the tree, with its source slice. */
function nodes(source: string): NodeRec[] {
  const tree = parser.parse(source);
  const out: NodeRec[] = [];
  tree.iterate({
    enter: (n) => {
      out.push({ name: n.name, from: n.from, to: n.to, text: source.slice(n.from, n.to) });
    },
  });
  return out;
}

function first(source: string, name: string): NodeRec | undefined {
  return nodes(source).find((n) => n.name === name);
}

/** Collapsed body text of the first FootnoteDefinition (source slice after the
 *  last `FootnoteMark`, i.e. `]:`, to the node end) — mirrors the collector. */
function defBodyText(source: string): string | null {
  const tree = parser.parse(source);
  let result: string | null = null;
  tree.iterate({
    enter: (n) => {
      if (n.name !== "FootnoteDefinition" || result !== null) return;
      const node = n.node;
      let lastMark: number | null = null;
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.name === "FootnoteMark") lastMark = c.to;
      }
      result =
        lastMark !== null
          ? source.slice(lastMark, node.to).replace(/\s+/g, " ").trim()
          : "";
    },
  });
  return result;
}

/** Names of the FootnoteDefinition's direct child block nodes (excludes the
 *  marker children). */
function defChildBlocks(source: string): string[] {
  const tree = parser.parse(source);
  const out: string[] = [];
  tree.iterate({
    enter: (n) => {
      if (n.name !== "FootnoteDefinition") return;
      for (let c = n.node.firstChild; c; c = c.nextSibling) {
        if (c.name !== "FootnoteMark" && c.name !== "FootnoteLabel") out.push(c.name);
      }
      return false;
    },
  });
  return out;
}

describe("FootnoteReference (inline)", () => {
  it("emits a FootnoteReference node for [^1] with the id recoverable", () => {
    const src = "see [^1] here";
    const ref = first(src, "FootnoteReference");
    expect(ref).toBeDefined();
    expect(ref!.text).toBe("[^1]");
    const label = first(src, "FootnoteLabel");
    expect(label!.text).toBe("1");
  });

  it("exposes locatable bracket marks `[^` and `]`", () => {
    const src = "x [^1] y";
    const marks = nodes(src).filter((n) => n.name === "FootnoteMark");
    expect(marks.map((m) => m.text)).toEqual(["[^", "]"]);
  });

  it("parses non-integer identifiers [^note] and [^a1] (§3.4)", () => {
    for (const id of ["note", "a1", "x-y_z"]) {
      const src = `ref [^${id}].`;
      const ref = first(src, "FootnoteReference");
      expect(ref, id).toBeDefined();
      expect(first(src, "FootnoteLabel")!.text).toBe(id);
    }
  });

  it("does not match an empty id [^]", () => {
    expect(first("a [^] b", "FootnoteReference")).toBeUndefined();
  });

  it("does not match when the id contains whitespace", () => {
    expect(first("a [^foo bar] b", "FootnoteReference")).toBeUndefined();
  });

  it("outranks standard link parsing (no Link node swallows [^1])", () => {
    const ns = nodes("see [^1](noturl)");
    expect(ns.some((n) => n.name === "FootnoteReference")).toBe(true);
  });
});

describe("FootnoteDefinition (block)", () => {
  it("emits a FootnoteDefinition with id + body for [^1]: note", () => {
    const src = "[^1]: First note.";
    expect(first(src, "FootnoteDefinition")).toBeDefined();
    expect(first(src, "FootnoteLabel")!.text).toBe("1");
    expect(defBodyText(src)).toBe("First note.");
  });

  it("exposes `[^` and `]:` marks on the definition", () => {
    const marks = nodes("[^1]: note").filter((n) => n.name === "FootnoteMark");
    expect(marks.map((m) => m.text)).toEqual(["[^", "]:"]);
  });

  it("handles non-integer definition ids", () => {
    const src = "[^note]: A named footnote.";
    expect(first(src, "FootnoteDefinition")).toBeDefined();
    expect(first(src, "FootnoteLabel")!.text).toBe("note");
    expect(defBodyText(src)).toBe("A named footnote.");
  });

  it("allows a bare empty definition [^1]:", () => {
    const src = "[^1]:";
    expect(first(src, "FootnoteDefinition")).toBeDefined();
    expect(defBodyText(src)).toBe("");
  });

  it("is claimed as a footnote definition, not a CommonMark link reference", () => {
    const ns = nodes("[^1]: text with spaces");
    expect(ns.some((n) => n.name === "FootnoteDefinition")).toBe(true);
    expect(ns.some((n) => n.name === "LinkReference")).toBe(false);
  });

  it("collects a reference and its definition in the same document", () => {
    const src = "Body with [^1] marker.\n\n[^1]: The note.\n";
    const ns = nodes(src);
    expect(ns.filter((n) => n.name === "FootnoteReference")).toHaveLength(1);
    expect(ns.filter((n) => n.name === "FootnoteDefinition")).toHaveLength(1);
  });
});

describe("multi-line FootnoteDefinition (composite body, MYND-153 AC#3)", () => {
  it("absorbs a 4-space-indented continuation line into the body", () => {
    const src = "[^1]: line one\n    line two\n";
    expect(defBodyText(src)).toBe("line one line two");
  });

  it("supports multiple paragraphs separated by a blank line", () => {
    const src = "[^1]: para one\n\n    para two\n";
    const blocks = defChildBlocks(src);
    expect(blocks.filter((b) => b === "Paragraph")).toHaveLength(2);
  });

  it("parses a fenced code block inside the footnote body", () => {
    const src = "[^1]: intro\n\n    ```js\n    const x = 1;\n    ```\n";
    expect(defChildBlocks(src)).toContain("FencedCode");
  });

  it("parses a blockquote inside the footnote body", () => {
    const src = "[^1]: intro\n\n    > quoted line\n";
    expect(defChildBlocks(src)).toContain("Blockquote");
  });

  it("a blank line separates the footnote from following body text", () => {
    const src = "[^1]: the note\n\nplain paragraph\n";
    // The blank line closes the footnote body; the paragraph is its own block.
    expect(defBodyText(src)).toBe("the note");
    const def = first(src, "FootnoteDefinition")!;
    expect(src.slice(def.from, def.to)).not.toContain("plain paragraph");
  });

  it("a following unindented footnote definition is its own node", () => {
    const src = "[^1]: first\n[^2]: second\n";
    const defs = nodes(src).filter((n) => n.name === "FootnoteDefinition");
    expect(defs).toHaveLength(2);
  });
});

describe("recognizer-only (no byte mutation)", () => {
  it("the config emits nodes whose ranges exactly cover the source", () => {
    const src = "a [^1] b\n\n[^1]: note\n";
    const tree = parser.parse(src);
    // The root spans the whole document; node slices are sub-ranges — there is
    // no rewrite path in a MarkdownConfig, so this is a structural guard only.
    expect(tree.length).toBe(src.length);
  });

  it("Footnote config is composed into the shared parser", () => {
    // The config object is the one wired in parser.ts / extensions.ts.
    expect(Footnote.defineNodes).toBeDefined();
    expect(Footnote.parseInline?.[0]?.name).toBe("FootnoteReference");
    expect(Footnote.parseBlock?.[0]?.name).toBe("FootnoteDefinition");
  });
});
