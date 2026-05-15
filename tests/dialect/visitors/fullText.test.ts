// FullText visitor — fixture-driven tests + invariants.
//
// `extractFullText(source) → string` produces decoration-stripped,
// frontmatter-excluded, code-block-INCLUDED plain text. Whitespace is
// normalized: consecutive whitespace runs collapse to single space;
// leading/trailing trimmed.

import { describe, expect, it } from "vitest";
import { extractFullText } from "../../../src/dialect/visitors/fullText";
import { readFixture } from "../_helpers";

function read(name: string): string {
  return readFixture("full-text", name);
}

describe("extractFullText — fixtures", () => {
  it("decoration-stripped: removes emphasis/strong/strike/code/link/wikilink decoration", () => {
    expect(extractFullText(read("decoration-stripped.md"))).toBe(
      "Heading bold italic strike code link text. Note and Alias and Note and image.png",
    );
  });

  it("code-block-included: keeps fenced + indented code content", () => {
    const result = extractFullText(read("code-block-included.md"));
    expect(result).toContain("Before.");
    expect(result).toContain("const x = 1;");
    expect(result).toContain("After.");
    expect(result).toContain("indented code line");
    expect(result).toContain("End.");
    // No code-fence markers
    expect(result).not.toContain("```");
    // No language label
    expect(result).not.toContain("ts ");
  });

  it("frontmatter-excluded: never includes YAML keys or values", () => {
    const result = extractFullText(read("frontmatter-excluded.md"));
    expect(result).not.toContain("title:");
    expect(result).not.toContain("Should not appear");
    expect(result).not.toContain("tags:");
    expect(result).not.toContain("foo");
    expect(result).not.toContain("bar");
    expect(result).toContain("Real Body");
    expect(result).toContain("This is the actual content.");
  });
});

describe("extractFullText — invariants", () => {
  it("returns empty string for empty source", () => {
    expect(extractFullText("")).toBe("");
  });

  it("collapses consecutive whitespace and trims", () => {
    expect(extractFullText("  multiple   spaces\n\n\nand newlines  ")).toBe(
      "multiple spaces and newlines",
    );
  });

  it("preserves wikilink alias over target when alias is present", () => {
    expect(extractFullText("[[Hidden|Visible]]")).toBe("Visible");
  });

  it("uses target when wikilink has no alias", () => {
    expect(extractFullText("[[JustTarget]]")).toBe("JustTarget");
  });

  it("excludes wikilink heading anchor and block-id from text", () => {
    expect(extractFullText("[[Note#Heading]]")).toBe("Note");
    expect(extractFullText("[[Note^block-id]]")).toBe("Note");
  });

  it("includes image alt text in fullText", () => {
    expect(extractFullText("![image alt text](img.png)")).toBe(
      "image alt text",
    );
  });

  it("never throws on adversarial input", () => {
    const inputs = [
      "\0",
      "---\n---\n",
      "```\n",
      "[[",
      "![",
      "**unclosed",
      "x".repeat(5000),
    ];
    for (const input of inputs) {
      expect(() => extractFullText(input)).not.toThrow();
    }
  });
});
