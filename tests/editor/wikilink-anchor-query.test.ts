import { describe, expect, it } from "vitest";
import {
  extractBlockAnchors,
  findQueryRange,
  resolveAnchorOffset,
  resolveAnchorRange,
} from "../../src/editor/wikilink/anchor";

// MYND-448 scroll-to-match: the `query` anchor resolves to the earliest literal
// term occurrence, as a selectable range (D3 earliest-term, D4 select-the-match).
describe("findQueryRange", () => {
  const body = "# Title\n\nThe quick brown fox jumps over the lazy dog.\nExport to PDF works.";

  it("returns the earliest occurrence of a single term", () => {
    const r = findQueryRange(body, "fox");
    expect(r).not.toBeNull();
    expect(body.slice(r!.from, r!.to)).toBe("fox");
  });

  it("is case-insensitive but returns raw offsets", () => {
    const r = findQueryRange(body, "QUICK");
    expect(body.slice(r!.from, r!.to)).toBe("quick");
  });

  it("a multi-word query lands on whichever term appears first", () => {
    // 'PDF' appears later than 'quick' → earliest term wins.
    const r = findQueryRange(body, "pdf quick");
    expect(body.slice(r!.from, r!.to).toLowerCase()).toBe("quick");
  });

  it("returns null when no term occurs literally (stem-only hit)", () => {
    expect(findQueryRange(body, "running")).toBeNull();
  });

  it("ignores surrounding / repeated whitespace", () => {
    const r = findQueryRange(body, "   fox   ");
    expect(body.slice(r!.from, r!.to)).toBe("fox");
  });

  it("escapes regex metacharacters in the term", () => {
    const b = "a+b costs $5 (approx).";
    const r = findQueryRange(b, "$5");
    expect(b.slice(r!.from, r!.to)).toBe("$5");
  });
});

describe("resolveAnchorRange dispatch (SYNC-5)", () => {
  const body = "# Heading One\n\nsome body text with a target word.";

  it("query anchor → a non-empty selectable range", () => {
    const r = resolveAnchorRange(body, { query: "target" });
    expect(r).not.toBeNull();
    expect(body.slice(r!.from, r!.to)).toBe("target");
    expect(r!.to).toBeGreaterThan(r!.from);
  });

  it("heading anchor → zero-length caret at the heading line", () => {
    const r = resolveAnchorRange(body, { heading: "Heading One" });
    expect(r).not.toBeNull();
    expect(r!.to).toBe(r!.from);
  });

  it("resolveAnchorOffset stays back-compat (the range start)", () => {
    const range = resolveAnchorRange(body, { query: "target" });
    expect(resolveAnchorOffset(body, { query: "target" })).toBe(range!.from);
  });

  it("null anchor or no match → null", () => {
    expect(resolveAnchorRange(body, null)).toBeNull();
    expect(resolveAnchorRange(body, { query: "zzzznotpresent" })).toBeNull();
  });
});

// MYND-382 [[^^ — enumerate imported ^block-id markers (no minting).
describe("extractBlockAnchors", () => {
  it("finds all end-of-line block markers with their line-start offsets", () => {
    const body = "First block. ^abc123\n\nSecond para.\nAnother line ^def-456\n";
    const anchors = extractBlockAnchors(body);
    expect(anchors.map((a) => a.blockId)).toEqual(["abc123", "def-456"]);
    // Each `from` is the START of the line carrying the marker.
    expect(body.slice(anchors[0]!.from).startsWith("First block")).toBe(true);
    expect(body.slice(anchors[1]!.from).startsWith("Another line")).toBe(true);
  });

  it("matches a marker at the very line start", () => {
    const body = "^solo\n";
    expect(extractBlockAnchors(body)).toEqual([{ blockId: "solo", from: 0 }]);
  });

  it("ignores mid-line carets and empty bodies", () => {
    expect(extractBlockAnchors("a ^mid caret not at EOL\n")).toEqual([]);
    expect(extractBlockAnchors("")).toEqual([]);
  });

  it("returns anchors in document order", () => {
    const body = "l1 ^one\nl2 ^two\nl3 ^three\n";
    expect(extractBlockAnchors(body).map((a) => a.blockId)).toEqual(["one", "two", "three"]);
  });
});
