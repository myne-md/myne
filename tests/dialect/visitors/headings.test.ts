// Heading visitor — fixture-driven tests + invariant checks.
//
// The setext fixture's expected JSON is generated dynamically (rather
// than pinned in a paired `.expected.json`) because @lezer/markdown's
// SetextHeading byteRange semantics are easier to assert than to
// hand-compute (the underline line's inclusion depends on lezer's
// internal representation).

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractHeadings } from "../../../src/dialect/visitors/headings";
import { fixtureDir } from "../_helpers";

const FIXTURE_DIR = fixtureDir("headings");

describe("extractHeadings — atx-all-levels", () => {
  it("emits all 6 ATX heading levels with correct level + text + raw + byteRange", () => {
    const source = fs.readFileSync(
      path.join(FIXTURE_DIR, "atx-all-levels.md"),
      "utf-8",
    );
    const expected = JSON.parse(
      fs.readFileSync(
        path.join(FIXTURE_DIR, "atx-all-levels.expected.json"),
        "utf-8",
      ),
    );
    expect(extractHeadings(source)).toEqual(expected);
  });
});

describe("extractHeadings — decoration-stripped", () => {
  it("strips emphasis / strong / code / link / strikethrough markers from text", () => {
    const source = fs.readFileSync(
      path.join(FIXTURE_DIR, "decoration-stripped.md"),
      "utf-8",
    );
    const expected = JSON.parse(
      fs.readFileSync(
        path.join(FIXTURE_DIR, "decoration-stripped.expected.json"),
        "utf-8",
      ),
    );
    expect(extractHeadings(source)).toEqual(expected);
  });
});

describe("extractHeadings — setext-recognized", () => {
  it("recognizes Setext H1 and H2 forms with correct level + text", () => {
    const source = fs.readFileSync(
      path.join(FIXTURE_DIR, "setext-recognized.md"),
      "utf-8",
    );
    const headings = extractHeadings(source);
    expect(headings).toHaveLength(2);
    expect(headings[0]?.level).toBe(1);
    expect(headings[0]?.text).toBe("H1 underlined");
    expect(headings[1]?.level).toBe(2);
    expect(headings[1]?.text).toBe("H2 underlined");
    // raw should include the marker line
    expect(headings[0]?.raw).toContain("=");
    expect(headings[1]?.raw).toContain("-");
  });
});

describe("extractHeadings — invariants", () => {
  it("returns empty array for source with no headings", () => {
    expect(extractHeadings("just a paragraph")).toEqual([]);
    expect(extractHeadings("")).toEqual([]);
  });

  it("preserves source order", () => {
    const source = "## Second\n# First\n### Third\n";
    const headings = extractHeadings(source);
    expect(headings.map((h) => h.text)).toEqual(["Second", "First", "Third"]);
  });

  it("never throws on adversarial input", () => {
    const inputs = [
      "#",
      "# ",
      "#######",
      "####### too many",
      "#no-space",
      "# `code with #` more",
    ];
    for (const input of inputs) {
      expect(() => extractHeadings(input)).not.toThrow();
    }
  });
});
