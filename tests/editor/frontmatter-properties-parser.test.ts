// `parseProperties` — the scalar-vs-sequence classification the Properties
// widget renders from. Scalar keys keep their byte ranges; a top-level key whose
// YAML value is an array is upgraded to a `sequence` row carrying decoded items.
// (The block-sequence display bug this fixes: an AI-accepted `tags:` block used
// to reach the widget as a scalar with an empty value, rendering an empty input.)

import { describe, it, expect } from "vitest";
import { locateFrontmatter } from "@myne/dialect/lezer/frontmatter";
import { parseProperties } from "../../src/editor/frontmatter-properties";

function rows(doc: string) {
  const range = locateFrontmatter(doc);
  return range === null ? [] : parseProperties(doc, range);
}

describe("parseProperties — scalar vs sequence classification", () => {
  it("classifies a scalar key as a scalar row with its value", () => {
    const r = rows("---\nstatus: draft\n---\nb");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "scalar", key: "status", value: "draft" });
  });

  it("classifies a block sequence as a sequence row with decoded items", () => {
    const r = rows("---\ntags:\n  - a\n  - b\n---\nb");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      kind: "sequence",
      key: "tags",
      items: ["a", "b"],
    });
  });

  it("classifies a flow sequence as a sequence row", () => {
    const r = rows("---\ntags: [a, b]\n---\nb");
    expect(r[0]).toMatchObject({
      kind: "sequence",
      key: "tags",
      items: ["a", "b"],
    });
  });

  it("keeps source order across mixed scalar + sequence keys", () => {
    const r = rows("---\ntitle: N\ntags:\n  - a\nstatus: draft\n---\nb");
    expect(r.map((p) => [p.kind, p.key])).toEqual([
      ["scalar", "title"],
      ["sequence", "tags"],
      ["scalar", "status"],
    ]);
    // the block sequence's `- a` line does not produce its own row
    expect(r).toHaveLength(3);
  });

  it("does not upgrade an indented key inside a nested mapping", () => {
    const r = rows("---\nmeta:\n  tags:\n    - a\n---\nb");
    expect(r.map((p) => p.key)).toEqual(["meta"]);
    expect(r[0]!.kind).toBe("scalar");
  });

  it("leaves a scalar-valued `tags:` as a scalar row", () => {
    const r = rows("---\ntags: work\n---\nb");
    expect(r[0]).toMatchObject({ kind: "scalar", key: "tags", value: "work" });
  });

  it("falls back to all-scalar rows when the YAML does not parse", () => {
    const r = rows("---\ntags:\n  - a\nbroken: [unclosed\n---\nb");
    expect(r.every((p) => p.kind === "scalar")).toBe(true);
  });
});
