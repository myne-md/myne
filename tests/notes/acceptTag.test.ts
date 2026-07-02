import { describe, expect, it } from "vitest";

import {
  appendInlineTag,
  computeTagsAfterAccept,
} from "../../src/notes/ai/acceptTag";

// auto-tag-link (MYND-411) task 5 — accept-write pure cores.
describe("computeTagsAfterAccept (frontmatter tags:)", () => {
  it("appends a genuinely-new tag", () => {
    expect(computeTagsAfterAccept(["work"], "rust")).toEqual(["work", "rust"]);
  });

  it("is idempotent — re-accepting an existing tag does not duplicate it", () => {
    expect(computeTagsAfterAccept(["work"], "work")).toEqual(["work"]);
  });

  it("dedupes under the fold (case/NFC) preserving existing casing", () => {
    expect(computeTagsAfterAccept(["Work"], "work")).toEqual(["Work"]);
    expect(computeTagsAfterAccept(["work"], "WORK")).toEqual(["work"]);
  });

  it("strips a leading '#' on the accepted tag", () => {
    expect(computeTagsAfterAccept(["work"], "#rust")).toEqual(["work", "rust"]);
    expect(computeTagsAfterAccept(["rust"], "#rust")).toEqual(["rust"]);
  });

  it("ignores an empty / whitespace / bare-hash accept", () => {
    expect(computeTagsAfterAccept(["work"], "  ")).toEqual(["work"]);
    expect(computeTagsAfterAccept(["work"], "#")).toEqual(["work"]);
  });

  it("does not mutate the input array", () => {
    const input = ["work"];
    computeTagsAfterAccept(input, "rust");
    expect(input).toEqual(["work"]);
  });
});

describe("appendInlineTag (inline #tag body insert)", () => {
  it("appends a new inline tag with a separating space", () => {
    expect(appendInlineTag("some note body", "rust")).toBe("some note body #rust");
  });

  it("appends without a leading space when the body ends in whitespace", () => {
    expect(appendInlineTag("body\n", "rust")).toBe("body\n#rust");
  });

  it("appends bare when the body is empty", () => {
    expect(appendInlineTag("", "rust")).toBe("#rust");
  });

  it("is idempotent when the tag already exists inline (fold-compared)", () => {
    expect(appendInlineTag("about #Rust here", "rust")).toBe("about #Rust here");
    expect(appendInlineTag("#work at start", "work")).toBe("#work at start");
  });

  it("does not false-match a tag that is a prefix of an existing one", () => {
    // #ml must not be considered present just because #machine-learning is.
    expect(appendInlineTag("tagged #machine-learning", "ml")).toBe(
      "tagged #machine-learning #ml",
    );
  });

  it("strips a leading '#' on the accepted tag and ignores empties", () => {
    expect(appendInlineTag("body", "#rust")).toBe("body #rust");
    expect(appendInlineTag("body", "   ")).toBe("body");
  });
});
