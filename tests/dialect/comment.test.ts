// Dialect comment parser registration (MYND-315, editor-comments task 1).
// `%%…%%` inline + multi-line block, both terminated-only; an unterminated `%%`
// is inert (no node, stays plain text). Structurally excluded from code /
// inline-code / wikilink / math-leaf / frontmatter zones. Recognize-only —
// never mutates bytes. Spec: myne-agents/docs/spec/markdown-dialect.md §3.1 / §3.2 / §3.7.5.

import { describe, expect, it } from "vitest";
import { parser } from "../../src/dialect/lezer/parser";

function nodeNames(src: string): Set<string> {
  const names = new Set<string>();
  parser.parse(src).iterate({
    enter: (n) => {
      names.add(n.name);
    },
  });
  return names;
}

/** Absolute byte range of the first node named `name`, or null. */
function firstRange(src: string, name: string): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  parser.parse(src).iterate({
    enter: (n) => {
      if (found === null && n.name === name) found = { from: n.from, to: n.to };
    },
  });
  return found;
}

describe("inline `%%…%%` comments", () => {
  it("parses an inline comment as a DialectComment with marks", () => {
    const n = nodeNames("before %%a note to self%% after\n");
    expect(n).toContain("DialectComment");
    expect(n).toContain("DialectCommentMark");
  });

  it("spans exactly the `%%…%%` run", () => {
    const src = "x %%c%% y\n";
    const r = firstRange(src, "DialectComment");
    expect(r).not.toBeNull();
    expect(src.slice(r!.from, r!.to)).toBe("%%c%%");
  });

  it("treats an UNTERMINATED inline `%%` as plain text (no node)", () => {
    expect(nodeNames("a %% lone opener with no closer\n")).not.toContain(
      "DialectComment",
    );
  });

  it("does not treat `%` (single) as a comment", () => {
    expect(nodeNames("100% sure\n")).not.toContain("DialectComment");
  });
});

describe("block / multi-line `%%`…`%%` comments", () => {
  it("parses a single-line block comment on its own line", () => {
    const n = nodeNames("%% a whole-line note %%\n");
    expect(n).toContain("DialectCommentBlock");
  });

  it("parses a multi-line terminated block comment", () => {
    const src = "%% line one\nline two\nclosing %%\nvisible\n";
    const n = nodeNames(src);
    expect(n).toContain("DialectCommentBlock");
    const r = firstRange(src, "DialectCommentBlock");
    expect(src.slice(r!.from, r!.to)).toBe("%% line one\nline two\nclosing %%");
  });

  // myne#323 — the canonical multi-line shape the spec documents: the closing
  // `%%` first on its own line.
  //
  // lezer consults `endLeaf` stops BEFORE the leaf parsers' `nextLine`, and the
  // closing line also starts with `%%` — so the stop fired on the closer, broke
  // out of the line loop, and `finish` found no closer in the accumulated
  // content and declined. The whole closer-on-its-own-line branch was
  // unreachable and the comment parsed as ordinary prose: not dimmed, not
  // excluded from document statistics, and NOT STRIPPED — so an editor-private
  // note-to-self shipped verbatim in exported HTML, in the printed PDF and in
  // stripped TXT, with `hasDialectComment` answering false so nothing upstream
  // could warn.
  it("parses a block comment whose closer begins its own line", () => {
    const src = "%%\nTODO: ask legal about the NDA\n%%\nvisible\n";
    const n = nodeNames(src);
    expect(n).toContain("DialectCommentBlock");
    const r = firstRange(src, "DialectCommentBlock");
    expect(src.slice(r!.from, r!.to)).toBe("%%\nTODO: ask legal about the NDA\n%%");
  });

  it("parses one whose closer is indented up to three spaces", () => {
    const src = "%%\nprivate\n   %%\nvisible\n";
    expect(nodeNames(src)).toContain("DialectCommentBlock");
  });

  it("still lets a NEW comment interrupt an open paragraph", () => {
    // The behaviour the `endLeaf` stop exists for, and which the fix must not
    // cost: a block comment may follow prose with no blank line between.
    const src = "prose here\n%% a note %%\n";
    expect(nodeNames(src)).toContain("DialectCommentBlock");
  });

  it("leaves an UNTERMINATED block `%%` inert (no block node)", () => {
    const src = "%% opened but never closed\n\nmore prose below\n";
    const n = nodeNames(src);
    expect(n).not.toContain("DialectCommentBlock");
    // The prose below still parses as ordinary content.
    expect(n).toContain("Paragraph");
  });

  it("a heading below an unterminated `%%` still parses as a heading", () => {
    const src = "%% never closed\n\n# Real Heading\n";
    expect(nodeNames(src)).toContain("ATXHeading1");
  });
});

describe("exclusion zones (§3.7.5)", () => {
  it("does not parse `%%` inside a fenced code block", () => {
    const src = "```\n%%not a comment%%\n```\n";
    expect(nodeNames(src)).not.toContain("DialectComment");
    expect(nodeNames(src)).not.toContain("DialectCommentBlock");
  });

  it("does not parse `%%` inside inline code", () => {
    expect(nodeNames("a `%%no%%` b\n")).not.toContain("DialectComment");
  });

  it("does not parse `%%` inside a wikilink", () => {
    expect(nodeNames("[[Note %%no%%]]\n")).not.toContain("DialectComment");
  });

  it("does not parse `%%` inside inline math", () => {
    expect(nodeNames("$x %%no%% y$\n")).not.toContain("DialectComment");
  });
});

describe("recognize-only (no byte rewrite on parse)", () => {
  it("the parsed tree spans the full source verbatim", () => {
    const src = "a %%c%% b\n%% block %%\n";
    const tree = parser.parse(src);
    expect(tree.length).toBe(src.length);
  });
});
