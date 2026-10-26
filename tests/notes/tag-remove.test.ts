// myne-md/myne#908 — the inverse of the tag accept.
//
// Automatic tagging writes without a click, so the only thing that makes it
// safe is that the write can be taken back. The removal is recomputed against
// the CURRENT document rather than replaying a stored copy, which is what lets
// undo survive the user typing after the write.

import { describe, expect, it } from "vitest";
import {
  applyTagAccept,
  computeTagRemoveEdit,
} from "../../src/notes/ai/acceptTag";

const apply = (doc: string, tag: string): string => {
  const edit = computeTagRemoveEdit(doc, tag);
  if (edit === null) return doc;
  return doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to);
};

describe("computeTagRemoveEdit", () => {
  it("removes one item from a block sequence and keeps its sibling", () => {
    const doc = "---\ntags:\n  - keep\n  - drop\n---\n\nbody\n";
    const out = apply(doc, "drop");
    expect(out).toContain("- keep");
    expect(out).not.toContain("- drop");
    expect(out).toContain("body");
  });

  it("collapses the key line when the last item goes", () => {
    const doc = "---\ntags:\n  - only\n---\n\nbody\n";
    const out = apply(doc, "only");
    expect(out).not.toContain("tags:");
    expect(out).not.toContain("- only");
    expect(out).toContain("body");
  });

  it("rebuilds a flow sequence", () => {
    const doc = "---\ntags: [a, b, c]\n---\n\nbody\n";
    const out = apply(doc, "b");
    expect(out).toContain("tags: [a, c]");
  });

  it("matches under the tag-identity fold", () => {
    const doc = "---\ntags:\n  - Myne\n---\n\nbody\n";
    expect(apply(doc, "myne")).not.toContain("- Myne");
  });

  it("is a no-op for a tag the note does not carry", () => {
    const doc = "---\ntags:\n  - keep\n---\n\nbody\n";
    expect(computeTagRemoveEdit(doc, "absent")).toBeNull();
  });

  it("never touches an inline #tag in the prose", () => {
    const doc = "---\ntitle: x\n---\n\nI write about #myne here.\n";
    expect(computeTagRemoveEdit(doc, "myne")).toBeNull();
    expect(apply(doc, "myne")).toContain("#myne");
  });

  it("refuses frontmatter shapes the writer refuses", () => {
    expect(computeTagRemoveEdit("---\ntags: {a: 1}\n---\n", "a")).toBeNull();
    expect(computeTagRemoveEdit("---\ntags: |\n  a\n---\n", "a")).toBeNull();
  });

  it("round-trips with the accept for a note that had no tags", () => {
    // The shape automatic tagging most often produces: a note with frontmatter
    // and no tags key at all.
    const before = "---\ntitle: note\n---\n\nbody\n";
    const added = applyTagAccept(before, "fresh");
    expect(added).toContain("fresh");
    const back = apply(added, "fresh");
    expect(back).toContain("title: note");
    expect(back).not.toContain("fresh");
  });
});
