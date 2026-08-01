// Frontmatter block/flow-sequence editing core — the key-parameterized engine
// shared by the AI tag-accept path (`src/notes/ai/acceptTag.ts`, which has its
// own thorough state coverage) and the editor's frontmatter chip widget. These
// exercise it directly for a NON-tags key and cover the removal side (which
// acceptTag has no counterpart for).

import { describe, it, expect } from "vitest";
import {
  planSequenceItemInsert,
  planSequenceItemRemove,
  readFrontmatterSequences,
} from "../../src/dialect/frontmatterSequence";

/** Apply an insert plan for `key`+`item` to `doc`, or return `doc` unchanged. */
function applyInsert(doc: string, key: string, item: string): string {
  const plan = planSequenceItemInsert(doc, key);
  if (plan === null) return doc;
  const e = plan(item);
  return doc.slice(0, e.from) + e.insert + doc.slice(e.to);
}

/** Apply a remove plan for `key`+`targetFold` to `doc`, or return `doc`. */
function applyRemove(doc: string, key: string, fold: string): string {
  const e = planSequenceItemRemove(doc, key, fold);
  if (e === null) return doc;
  return doc.slice(0, e.from) + e.insert + doc.slice(e.to);
}

describe("readFrontmatterSequences", () => {
  it("reads a block sequence's decoded items", () => {
    const seqs = readFrontmatterSequences("---\ntags:\n  - work\n  - ops\n---\nb");
    expect(seqs?.get("tags")).toEqual(["work", "ops"]);
  });

  it("reads a flow sequence's decoded items", () => {
    const seqs = readFrontmatterSequences("---\ntags: [work, ops]\n---\nb");
    expect(seqs?.get("tags")).toEqual(["work", "ops"]);
  });

  it("decodes quoted / re-typed items to their logical string", () => {
    const seqs = readFrontmatterSequences('---\ntags:\n  - "2026"\n  - true\n---\nb');
    expect(seqs?.get("tags")).toEqual(["2026", "true"]);
  });

  it("omits scalar and mapping values (only arrays surface)", () => {
    const seqs = readFrontmatterSequences("---\ntitle: Note\ntags:\n  - a\n---\nb");
    expect(seqs?.has("title")).toBe(false);
    expect(seqs?.get("tags")).toEqual(["a"]);
  });

  it("is null for no frontmatter and for unparseable YAML", () => {
    expect(readFrontmatterSequences("just a body\n")).toBeNull();
    expect(readFrontmatterSequences("---\ntitle: [unclosed\n---\nb")).toBeNull();
  });
});

describe("planSequenceItemInsert — key-parameterized (aliases)", () => {
  it("synthesizes a whole block for a note with no frontmatter", () => {
    expect(applyInsert("body\n", "aliases", "AKA")).toBe(
      "---\naliases:\n  - AKA\n---\n\nbody\n",
    );
  });

  it("adds the key to a block that lacks it", () => {
    expect(applyInsert("---\ntitle: N\n---\nb", "aliases", "AKA")).toBe(
      "---\ntitle: N\naliases:\n  - AKA\n---\nb",
    );
  });

  it("appends to an existing block sequence at its indentation", () => {
    expect(applyInsert("---\naliases:\n  - one\n---\nb", "aliases", "two")).toBe(
      "---\naliases:\n  - one\n  - two\n---\nb",
    );
  });

  it("appends to a flow sequence", () => {
    expect(applyInsert("---\naliases: [one]\n---\nb", "aliases", "two")).toBe(
      "---\naliases: [one, two]\n---\nb",
    );
  });

  it("refuses a mapping / block scalar / multi-line flow", () => {
    expect(planSequenceItemInsert("---\naliases: {a: 1}\n---\nb", "aliases")).toBeNull();
    expect(planSequenceItemInsert("---\naliases: |\n  x\n---\nb", "aliases")).toBeNull();
    expect(planSequenceItemInsert("---\naliases: [a,\n  b]\n---\nb", "aliases")).toBeNull();
  });
});

describe("planSequenceItemRemove — block sequence", () => {
  it("removes a middle item, keeping the rest byte-stable", () => {
    expect(applyRemove("---\ntags:\n  - a\n  - b\n  - c\n---\nx", "tags", "b")).toBe(
      "---\ntags:\n  - a\n  - c\n---\nx",
    );
  });

  it("removes the last remaining item AND collapses the key line", () => {
    expect(applyRemove("---\ntags:\n  - only\ntitle: N\n---\nx", "tags", "only")).toBe(
      "---\ntitle: N\n---\nx",
    );
  });

  it("matches case-insensitively (fold identity) and decodes quoted items", () => {
    expect(applyRemove("---\ntags:\n  - Work\n  - ops\n---\nx", "tags", "work")).toBe(
      "---\ntags:\n  - ops\n---\nx",
    );
    expect(applyRemove('---\ntags:\n  - "2026"\n  - ops\n---\nx', "tags", "2026")).toBe(
      "---\ntags:\n  - ops\n---\nx",
    );
  });

  it("is a no-op (null) when nothing folds onto the target", () => {
    expect(planSequenceItemRemove("---\ntags:\n  - a\n---\nx", "tags", "z")).toBeNull();
  });
});

describe("planSequenceItemRemove — flow sequence & scalar", () => {
  it("removes a flow item, re-serializing the remainder", () => {
    expect(applyRemove("---\ntags: [a, b, c]\n---\nx", "tags", "b")).toBe(
      "---\ntags: [a, c]\n---\nx",
    );
  });

  it("collapses the key line when the last flow item is removed", () => {
    expect(applyRemove("---\ntags: [only]\ntitle: N\n---\nx", "tags", "only")).toBe(
      "---\ntitle: N\n---\nx",
    );
  });

  it("re-quotes a re-typed flow item so it round-trips", () => {
    expect(applyRemove("---\ntags: [2026, work]\n---\nx", "tags", "work")).toBe(
      '---\ntags: ["2026"]\n---\nx',
    );
  });

  it("removes a lone scalar value by dropping its key line", () => {
    expect(applyRemove("---\ntags: work\ntitle: N\n---\nx", "tags", "work")).toBe(
      "---\ntitle: N\n---\nx",
    );
  });
});
