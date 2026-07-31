import { describe, expect, it } from "vitest";

import {
  applyTagAccept,
  computeTagAcceptEdit,
  planTagAccept,
} from "../../src/notes/ai/acceptTag";

// on-device-tag-suggestion task 6 — the accept-to-frontmatter writer. The single
// accept path: a chip writes into frontmatter `tags:`, never an inline `#tag`.
describe("computeTagAcceptEdit — synthesizing a frontmatter block", () => {
  it("prepends a whole block when the note has none", () => {
    expect(applyTagAccept("just a body\n", "rust")).toBe(
      "---\ntags:\n  - rust\n---\n\njust a body\n",
    );
  });

  it("synthesizes for an empty note", () => {
    expect(applyTagAccept("", "rust")).toBe("---\ntags:\n  - rust\n---\n\n");
  });

  it("synthesizes when the opener has no closer (not frontmatter, §3.6)", () => {
    expect(applyTagAccept("---\ntitle: x\n", "rust")).toBe(
      "---\ntags:\n  - rust\n---\n\n---\ntitle: x\n",
    );
  });

  it("edits only at offset 0 — the body bytes are untouched", () => {
    const edit = computeTagAcceptEdit("body\n", "rust");
    expect(edit).toEqual({ from: 0, to: 0, insert: "---\ntags:\n  - rust\n---\n\n" });
  });
});

describe("computeTagAcceptEdit — an existing frontmatter block", () => {
  it("adds a `tags:` key when the block has none, leaving other keys byte-identical", () => {
    expect(applyTagAccept("---\ntitle: Note\n---\n\nbody\n", "rust")).toBe(
      "---\ntitle: Note\ntags:\n  - rust\n---\n\nbody\n",
    );
  });

  it("appends to a block sequence after its last item, matching indentation", () => {
    expect(applyTagAccept("---\ntags:\n  - work\n  - ops\n---\nbody", "rust")).toBe(
      "---\ntags:\n  - work\n  - ops\n  - rust\n---\nbody",
    );
  });

  it("matches a zero-indent block sequence", () => {
    expect(applyTagAccept("---\ntags:\n- work\n---\nbody", "rust")).toBe(
      "---\ntags:\n- work\n- rust\n---\nbody",
    );
  });

  it("keeps a key that follows the sequence below the inserted item", () => {
    expect(applyTagAccept("---\ntags:\n  - work\ntitle: N\n---\nb", "rust")).toBe(
      "---\ntags:\n  - work\n  - rust\ntitle: N\n---\nb",
    );
  });

  it("appends to a flow sequence", () => {
    expect(applyTagAccept("---\ntags: [work, ops]\n---\nb", "rust")).toBe(
      "---\ntags: [work, ops, rust]\n---\nb",
    );
  });

  it("appends to an empty flow sequence", () => {
    expect(applyTagAccept("---\ntags: []\n---\nb", "rust")).toBe(
      "---\ntags: [rust]\n---\nb",
    );
  });

  it("turns a lone scalar into a two-item block sequence", () => {
    expect(applyTagAccept("---\ntags: work\n---\nb", "rust")).toBe(
      "---\ntags:\n  - work\n  - rust\n---\nb",
    );
  });

  it("keeps a trailing comment on the `tags:` line when promoting a scalar", () => {
    expect(applyTagAccept("---\ntags: work # mine\n---\nb", "rust")).toBe(
      "---\ntags: # mine\n  - work\n  - rust\n---\nb",
    );
  });

  it("fills an empty `tags:` key", () => {
    expect(applyTagAccept("---\ntags:\ntitle: N\n---\nb", "rust")).toBe(
      "---\ntags:\n  - rust\ntitle: N\n---\nb",
    );
  });

  it("ignores an indented `tags:` belonging to a nested mapping", () => {
    expect(applyTagAccept("---\nmeta:\n  tags:\n    - work\n---\nb", "rust")).toBe(
      "---\nmeta:\n  tags:\n    - work\ntags:\n  - rust\n---\nb",
    );
  });

  it("quotes a tag YAML would re-type away from a string", () => {
    expect(applyTagAccept("---\ntags:\n  - work\n---\nb", "2026")).toBe(
      '---\ntags:\n  - work\n  - "2026"\n---\nb',
    );
    expect(applyTagAccept("---\ntitle: N\n---\nb", "true")).toBe(
      '---\ntitle: N\ntags:\n  - "true"\n---\nb',
    );
  });
});

describe("computeTagAcceptEdit — idempotence under the tag-identity fold", () => {
  it("is a no-op when the tag is already in `tags:` (any case)", () => {
    expect(computeTagAcceptEdit("---\ntags:\n  - Work\n---\nb", "work")).toBeNull();
    expect(computeTagAcceptEdit("---\ntags: [work]\n---\nb", "WORK")).toBeNull();
    expect(computeTagAcceptEdit("---\ntags: work\n---\nb", "#work")).toBeNull();
  });

  it("is a no-op when the tag is already present as an inline `#tag`", () => {
    expect(computeTagAcceptEdit("---\ntitle: N\n---\n\nabout #Rust here", "rust")).toBeNull();
    expect(computeTagAcceptEdit("plain body with #rust", "rust")).toBeNull();
  });

  it("is a no-op when the tag is present under the singular `tag:` key", () => {
    expect(computeTagAcceptEdit("---\ntag: work\n---\nb", "work")).toBeNull();
  });

  it("does not treat a YAML comment inside frontmatter as an inline tag", () => {
    expect(applyTagAccept("---\ntitle: N # rust\n---\n\nbody", "rust")).toBe(
      "---\ntitle: N # rust\ntags:\n  - rust\n---\n\nbody",
    );
  });

  it("does not false-match a tag that is a prefix of an existing inline one", () => {
    expect(applyTagAccept("tagged #machine-learning", "ml")).toBe(
      "---\ntags:\n  - ml\n---\n\ntagged #machine-learning",
    );
  });

  it("is a no-op for an empty / whitespace / bare-hash accept", () => {
    expect(computeTagAcceptEdit("body", "")).toBeNull();
    expect(computeTagAcceptEdit("body", "   ")).toBeNull();
    expect(computeTagAcceptEdit("body", "#")).toBeNull();
  });

  it("re-applying its own output changes nothing", () => {
    const once = applyTagAccept("---\ntitle: N\n---\n\nbody\n", "rust");
    expect(applyTagAccept(once, "rust")).toBe(once);
    expect(applyTagAccept(once, "#RUST")).toBe(once);
  });
});

describe("computeTagAcceptEdit — frontmatter it refuses to touch", () => {
  it("refuses a block whose YAML does not parse", () => {
    expect(computeTagAcceptEdit("---\ntitle: [unclosed\n---\nb", "rust")).toBeNull();
  });

  it("refuses a `tags:` block scalar rather than mangling it", () => {
    expect(computeTagAcceptEdit("---\ntags: |\n  work\n---\nb", "rust")).toBeNull();
    expect(computeTagAcceptEdit("---\ntags: >\n  work\n---\nb", "rust")).toBeNull();
  });

  it("refuses a `tags:` mapping rather than mangling it", () => {
    expect(computeTagAcceptEdit("---\ntags: {a: 1}\n---\nb", "rust")).toBeNull();
    expect(computeTagAcceptEdit("---\ntags:\n  a: 1\n---\nb", "rust")).toBeNull();
  });

  it("refuses a multi-line flow sequence rather than mangling it", () => {
    expect(computeTagAcceptEdit("---\ntags: [work,\n  ops]\n---\nb", "rust")).toBeNull();
  });

  it("applyTagAccept returns the document unchanged when it refuses", () => {
    const doc = "---\ntitle: [unclosed\n---\nb";
    expect(applyTagAccept(doc, "rust")).toBe(doc);
  });
});

// The document half of the decision, split out so the suggestion band can ask
// "would any of these chips land?" with ONE parse per keystroke instead of one
// per chip. These assert the two things the band reads off it.
describe("planTagAccept — the per-document half", () => {
  it("reports what the note already claims, from both sources and folded", () => {
    const plan = planTagAccept("---\ntags:\n  - Work\ntag: 2026\n---\n\nabout #Rust here");
    expect(plan).not.toBeNull();
    expect([...plan!.existingFolds].sort()).toEqual(["2026", "rust", "work"]);
  });

  it("is null exactly when the writer refuses the frontmatter", () => {
    expect(planTagAccept("---\ntitle: [unclosed\n---\nb")).toBeNull();
    expect(planTagAccept("---\ntags: {a: 1}\n---\nb")).toBeNull();
    expect(planTagAccept("---\ntags: [work,\n  ops]\n---\nb")).toBeNull();
    expect(planTagAccept("plain body")).not.toBeNull();
  });

  it("agrees with computeTagAcceptEdit — one plan, reused across tags", () => {
    const doc = "---\ntags:\n  - work\n---\nbody";
    const plan = planTagAccept(doc)!;
    for (const tag of ["rust", "work", "WORK", "ops"]) {
      const viaPlan = plan.existingFolds.has(tag.toLowerCase())
        ? null
        : plan.edit(tag);
      expect(computeTagAcceptEdit(doc, tag)).toEqual(viaPlan);
    }
  });
});
