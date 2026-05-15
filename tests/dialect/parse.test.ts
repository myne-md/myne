// parse() aggregator — integration test + invariants.
//
// Verifies the all-in-one entry point: every visitor field populates,
// the lezer parser is called exactly once (single-parse contract),
// `parse()` never throws on adversarial input (including invalid
// UTF-8 bytes), and the three-state error contract is honored
// (frontmatter.error and errors[] populated independently).

import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "../../src/dialect/parse";
import { parser } from "../../src/dialect/lezer/parser";
import { fixtureDir } from "./_helpers";

const FIXTURE_DIR = fixtureDir("integration");

describe("parse — integration fixture", () => {
  const source = fs.readFileSync(
    path.join(FIXTURE_DIR, "all-fields-populated.md"),
    "utf-8",
  );

  it("populates frontmatter with parsed YAML and no error", () => {
    const result = parse(source);
    expect(result.frontmatter.error).toBeNull();
    expect(result.frontmatter.parsed).toEqual({
      title: "Integration Test",
      tags: ["demo", "fixture"],
    });
  });

  it("populates headings with both ATX H1 and H2", () => {
    const result = parse(source);
    expect(result.headings.map((h) => h.text)).toEqual([
      "Hello World",
      "Sub heading",
    ]);
  });

  it("populates wikilinks with both forms (target-only and alias)", () => {
    const result = parse(source);
    expect(result.wikilinks).toHaveLength(2);
    expect(result.wikilinks[0]?.target).toBe("Other Note");
    expect(result.wikilinks[0]?.alias).toBeNull();
    expect(result.wikilinks[1]?.target).toBe("Other");
    expect(result.wikilinks[1]?.alias).toBe("Display");
  });

  it("populates inlineTags", () => {
    const result = parse(source);
    expect(result.inlineTags.map((t) => t.tag)).toEqual(["demo-tag"]);
  });

  it("populates mediaRefs with the markdown image form", () => {
    const result = parse(source);
    expect(result.mediaRefs).toHaveLength(1);
    expect(result.mediaRefs[0]?.alt).toBe("alt-text");
    expect(result.mediaRefs[0]?.src).toBe("image.png");
  });

  it("populates fullText with body content (no frontmatter)", () => {
    const result = parse(source);
    expect(result.fullText).toContain("Hello World");
    expect(result.fullText).toContain("bold");
    expect(result.fullText).toContain("Sub heading");
    expect(result.fullText).toContain("demo-tag");
    expect(result.fullText).toContain("alt-text");
    expect(result.fullText).not.toContain("Integration Test");
    expect(result.fullText).not.toContain("title:");
  });

  it("body errors[] empty for the well-formed integration fixture", () => {
    const result = parse(source);
    expect(result.errors).toEqual([]);
  });
});

describe("parse — single lezer parse contract", () => {
  it("calls parser.parse exactly once per parse() invocation", () => {
    const spy = vi.spyOn(parser, "parse");
    spy.mockClear();
    parse("# Heading\n[[Note]] body with #tag and ![](img.png)");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("parse — invariants", () => {
  it("never throws on adversarial input", () => {
    const inputs: Array<string | Uint8Array> = [
      "",
      "\0",
      "---\n",
      "[[",
      "![",
      "**unclosed",
      "x".repeat(10000),
      new Uint8Array([0xff, 0xfe, 0xfd]),
      new Uint8Array(),
    ];
    for (const input of inputs) {
      expect(() => parse(input)).not.toThrow();
    }
  });

  it("accepts both string and Uint8Array input", () => {
    const text = "# Heading\nBody.";
    const fromString = parse(text);
    const fromBytes = parse(new TextEncoder().encode(text));
    expect(fromString.headings.map((h) => h.text)).toEqual(["Heading"]);
    expect(fromBytes.headings.map((h) => h.text)).toEqual(["Heading"]);
  });

  it("frontmatter.error and errors[] are populated independently", () => {
    // Malformed YAML in frontmatter; well-formed body.
    const malformedFm = parse('---\ntitle: "unclosed\n---\n# Body\n');
    expect(malformedFm.frontmatter.error).not.toBeNull();
    expect(malformedFm.errors).toEqual([]);
    expect(malformedFm.headings).toHaveLength(1);

    // Frontmatter opener without closer; body errors should report it.
    const unclosedFm = parse("---\nfoo: bar\nbody without closer\n");
    expect(unclosedFm.frontmatter.error).toBeNull();
    expect(unclosedFm.frontmatter.raw).toBeNull();
    expect(unclosedFm.errors.some((e) => e.kind === "frontmatter-unclosed"))
      .toBe(true);
  });

  it("returns ParseResult with all required fields even on empty input", () => {
    const result = parse("");
    expect(result.frontmatter).toBeDefined();
    expect(result.headings).toEqual([]);
    expect(result.wikilinks).toEqual([]);
    expect(result.inlineTags).toEqual([]);
    expect(result.mediaRefs).toEqual([]);
    expect(result.fullText).toBe("");
    expect(result.errors).toEqual([]);
  });
});
