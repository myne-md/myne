// Skeleton test — proves the dialect module's public type surface compiles
// + imports cleanly through the aggregator. Replaces a typecheck-only
// assertion with a runtime test so `pnpm test` exits 0 from the start.
//
// Subsequent tasks (6–17) replace this placeholder with per-visitor and
// per-surgery test files.

import { describe, expect, it } from "vitest";
import type {
  ByteRange,
  Frontmatter,
  HeadingRef,
  InlineTagRef,
  MediaRef,
  ParseError,
  ParseResult,
  WikilinkRef,
} from "../../src/dialect";

describe("dialect skeleton", () => {
  it("constructs an empty ParseResult conforming to the public types", () => {
    const range: ByteRange = { start: 0, end: 0 };
    const frontmatter: Frontmatter = {
      raw: null,
      parsed: null,
      byteRange: null,
      error: null,
    };
    const heading: HeadingRef = {
      level: 1,
      text: "x",
      raw: "# x",
      byteRange: range,
    };
    const wikilink: WikilinkRef = {
      raw: "[[x]]",
      byteRange: range,
      embed: false,
      target: "x",
      targetKind: "title",
      alias: null,
      heading: null,
      blockId: null,
    };
    const tag: InlineTagRef = { raw: "#x", tag: "x", byteRange: range };
    const media: MediaRef = {
      raw: "![](x)",
      byteRange: range,
      alt: "",
      src: "x",
    };
    const yamlError: ParseError = {
      kind: "yaml",
      severity: "error",
      message: "stub",
      line: 1,
      column: 1,
      byteOffset: 0,
    };
    const result: ParseResult = {
      frontmatter,
      headings: [heading],
      wikilinks: [wikilink],
      inlineTags: [tag],
      mediaRefs: [media],
      fullText: "",
      errors: [yamlError],
    };
    expect(result.frontmatter.raw).toBeNull();
    expect(result.headings).toHaveLength(1);
    expect(result.wikilinks[0]?.target).toBe("x");
    expect(result.inlineTags[0]?.tag).toBe("x");
    expect(result.mediaRefs[0]?.src).toBe("x");
    expect(result.errors[0]?.kind).toBe("yaml");
  });

  it("ParseError discriminated union exhaustive switch compiles", () => {
    const errors: ParseError[] = [
      { kind: "yaml", severity: "error", message: "", line: 0, column: 0, byteOffset: 0 },
      { kind: "frontmatter-unclosed", severity: "error", message: "", openerLine: 0 },
      { kind: "wikilink-unclosed", severity: "warning", message: "", byteOffset: 0 },
      { kind: "fenced-code-unclosed", severity: "warning", message: "", openerLine: 0 },
    ];
    for (const err of errors) {
      switch (err.kind) {
        case "yaml":
          expect(err.severity).toBe("error");
          break;
        case "frontmatter-unclosed":
          expect(err.severity).toBe("error");
          break;
        case "wikilink-unclosed":
          expect(err.severity).toBe("warning");
          break;
        case "fenced-code-unclosed":
          expect(err.severity).toBe("warning");
          break;
      }
    }
  });
});
