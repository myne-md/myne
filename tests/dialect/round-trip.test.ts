// Round-trip integration test — real-shape Obsidian export through
// `parse()` + `patchUpdatedField()`. Asserts:
//   1. All 6 ParseResult fields populate with non-empty values.
//   2. `patchUpdatedField(bytes, iso)` produces new bytes whose body
//      region (everything after the FM block) is byte-identical to
//      the input — C1 byte-stability for body.
//   3. Re-applying the same `iso` produces byte-identical output —
//      idempotency.
//   4. The patched output's frontmatter has the new `updated:` line
//      while preserving the existing keys (title, tags, created,
//      status).

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { locateFrontmatter } from "../../src/dialect/lezer/frontmatter";
import { parse } from "../../src/dialect/parse";
import { patchUpdatedField } from "../../src/dialect/surgery";
import { bytesEqual, dec, enc, fixtureDir } from "./_helpers";

const FIXTURE_PATH = path.join(fixtureDir("integration"), "obsidian-export.md");
const TEST_ISO = "2026-01-01T00:00:00Z";

describe("dialect — round-trip integration", () => {
  const sourceText = fs.readFileSync(FIXTURE_PATH, "utf-8");
  const sourceBytes = enc.encode(sourceText);

  it("parse() populates all 6 ParseResult fields with non-empty values", () => {
    const result = parse(sourceText);

    expect(result.frontmatter.parsed).not.toBeNull();
    expect(result.frontmatter.parsed?.title).toBe("A Real-Shape Obsidian Export");
    expect(result.frontmatter.parsed?.tags).toEqual([
      "daily",
      "obsidian",
      "imported",
    ]);

    expect(result.headings.length).toBeGreaterThanOrEqual(3);
    expect(result.headings[0]?.text).toBe("Today's Notes");

    expect(result.wikilinks.length).toBeGreaterThanOrEqual(3);
    const wikilinkTargets = result.wikilinks.map((w) => w.target);
    expect(wikilinkTargets).toContain("Building a Second Brain");
    expect(wikilinkTargets).toContain("Daily/2026-01-15");

    expect(result.inlineTags.length).toBeGreaterThanOrEqual(3);
    const tagStrings = result.inlineTags.map((t) => t.tag);
    expect(tagStrings).toContain("productivity/notes");
    expect(tagStrings).toContain("daily-tag");
    expect(tagStrings).toContain("parent/child/grand-child");

    expect(result.mediaRefs).toHaveLength(1);
    expect(result.mediaRefs[0]?.alt).toBe("tea");
    expect(result.mediaRefs[0]?.src).toBe("attachments/tea.png");

    expect(result.fullText).toContain("Today's Notes");
    expect(result.fullText).toContain("Building a Second Brain");
    expect(result.fullText).toContain("searchableExample");
    expect(result.fullText).not.toContain("title:");
    expect(result.fullText).not.toContain("A Real-Shape");

    expect(result.errors).toEqual([]);
  });

  it("patchUpdatedField produces byte-identical body region (C1 stability)", () => {
    const fm = locateFrontmatter(sourceText);
    expect(fm).not.toBeNull();
    const bodyStart = fm!.blockEnd;

    const patchedBytes = patchUpdatedField(sourceBytes, TEST_ISO);
    const patchedText = dec.decode(patchedBytes);
    const patchedFm = locateFrontmatter(patchedText);
    expect(patchedFm).not.toBeNull();
    const patchedBodyStart = patchedFm!.blockEnd;

    // Slice body region (everything after the FM block) from both.
    const originalBody = sourceText.substring(bodyStart);
    const patchedBody = patchedText.substring(patchedBodyStart);

    // The body should be byte-identical.
    expect(patchedBody).toBe(originalBody);
  });

  it("patchUpdatedField is idempotent — second patch produces byte-identical bytes", () => {
    const once = patchUpdatedField(sourceBytes, TEST_ISO);
    const twice = patchUpdatedField(once, TEST_ISO);
    expect(bytesEqual(once, twice)).toBe(true);
  });

  it("patched frontmatter retains existing keys + adds updated: with the iso", () => {
    const patched = patchUpdatedField(sourceBytes, TEST_ISO);
    const result = parse(patched);
    expect(result.frontmatter.parsed?.title).toBe("A Real-Shape Obsidian Export");
    expect(result.frontmatter.parsed?.tags).toEqual([
      "daily",
      "obsidian",
      "imported",
    ]);
    expect(result.frontmatter.parsed?.created).toBeDefined();
    expect(result.frontmatter.parsed?.status).toBe("published");
    // Note: js-yaml parses the timestamp as a Date object; the canonical
    // form-on-disk is the ISO string, but the parsed value is a Date.
    const updatedRaw = result.frontmatter.raw ?? "";
    expect(updatedRaw).toContain(`updated: ${TEST_ISO}`);
  });
});
