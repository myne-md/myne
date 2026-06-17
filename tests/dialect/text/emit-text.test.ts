// Plain-text projection emitter tests (note-export MYND-340 task 1).
//
// The stripped-plaintext projection: markdown syntax marks, frontmatter
// and embeds dropped; readable prose + block structure preserved. A
// genuinely lossy projection, distinct from the byte-verbatim `.md`
// export (SYNC-2).

import { describe, expect, it } from "vitest";
import { emitNoteText } from "../../../src/dialect/text/emitNoteText";

const ID = "a".repeat(64);

describe("inline mark stripping", () => {
  it("strips bold / italic / strikethrough / highlight / code marks", () => {
    expect(emitNoteText("**bold**")).toBe("bold");
    expect(emitNoteText("*italic*")).toBe("italic");
    expect(emitNoteText("~~struck~~")).toBe("struck");
    expect(emitNoteText("==marked==")).toBe("marked");
    expect(emitNoteText("`code`")).toBe("code");
    expect(emitNoteText("a **b** and *c* and `d`")).toBe("a b and c and d");
  });

  it("keeps a markdown link's text and drops its URL", () => {
    expect(emitNoteText("see [the docs](https://example.com) here")).toBe(
      "see the docs here",
    );
  });

  it("keeps a markdown image's alt text and drops the path", () => {
    expect(emitNoteText("![a cat](cat.png)")).toBe("a cat");
  });

  it("renders a plain wikilink as its display text", () => {
    expect(emitNoteText("[[Note Title]]")).toBe("Note Title");
    expect(emitNoteText("[[Target|Alias]]")).toBe("Alias");
  });

  it("keeps an inline tag as literal text (SYNC-17 parity)", () => {
    expect(emitNoteText("a #tag here")).toBe("a #tag here");
  });
});

describe("heading stripping", () => {
  it("strips ATX heading markers to bare text", () => {
    expect(emitNoteText("# Heading")).toBe("Heading");
    expect(emitNoteText("### Deep heading")).toBe("Deep heading");
    expect(emitNoteText("## Trailing closers ##")).toBe("Trailing closers");
  });

  it("strips Setext heading underlines", () => {
    expect(emitNoteText("Title\n=====")).toBe("Title");
  });
});

describe("frontmatter", () => {
  it("removes the frontmatter block entirely", () => {
    const note = "---\ntitle: My Note\nfolder: a/b\n---\nBody line.";
    expect(emitNoteText(note)).toBe("Body line.");
  });

  it("a frontmatter-only note projects to the empty string", () => {
    expect(emitNoteText("---\ntitle: X\n---\n")).toBe("");
  });
});

describe("embeds", () => {
  it("drops a form-C attachment embed (no plain-text projection)", () => {
    expect(emitNoteText(`before\n\n![[att:${ID}|pic.png]]\n\nafter`)).toBe(
      "before\n\nafter",
    );
  });

  it("drops a non-attachment wikilink embed", () => {
    expect(emitNoteText("text\n\n![[Some Note]]\n\nmore")).toBe(
      "text\n\nmore",
    );
  });
});

describe("block structure", () => {
  it("preserves multi-paragraph structure as blank-line-separated text", () => {
    expect(emitNoteText("First paragraph.\n\nSecond paragraph.")).toBe(
      "First paragraph.\n\nSecond paragraph.",
    );
  });

  it("renders bullet list items as plain '- ' lines", () => {
    expect(emitNoteText("- one\n- two\n- three")).toBe(
      "- one\n- two\n- three",
    );
  });

  it("renders ordered list items as plain lines (markers stripped)", () => {
    expect(emitNoteText("1. first\n2. second")).toBe("- first\n- second");
  });

  it("renders task list items with [ ] / [x] glyphs and stripped marks", () => {
    expect(emitNoteText("- [ ] todo\n- [x] done")).toBe(
      "- [ ] todo\n- [x] done",
    );
  });

  it("keeps code-block bodies, drops the fence + info string", () => {
    const note = "```js\nconst x = 1;\nconst y = 2;\n```";
    expect(emitNoteText(note)).toBe("const x = 1;\nconst y = 2;");
  });

  it("flattens a table to tab-separated rows", () => {
    const note = "| A | B |\n| - | - |\n| 1 | 2 |";
    expect(emitNoteText(note)).toBe("A\tB\n1\t2");
  });

  it("strips blockquote markers to the quoted text", () => {
    expect(emitNoteText("> quoted line")).toBe("quoted line");
  });
});

describe("purity + edge cases", () => {
  it("returns '' for empty input", () => {
    expect(emitNoteText("")).toBe("");
  });

  it("does not mutate the input (pure)", () => {
    const src = "# Title\n\n**bold** body";
    const before = src;
    emitNoteText(src);
    expect(src).toBe(before);
  });

  it("trims leading/trailing blank lines", () => {
    expect(emitNoteText("\n\n\nbody\n\n\n")).toBe("body");
  });
});
