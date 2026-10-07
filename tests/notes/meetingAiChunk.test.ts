// Meeting AI task 1: the transcript chunker (pure).
//
// The chunker feeds a map-reduce pass, so two properties matter and both are
// asserted here rather than assumed: the chunks are lossless (the concatenation
// reconstructs the transcript, so nothing is dropped) and no chunk splits a
// word (a mid-word cut would corrupt the summary of both chunks it straddles).

import { describe, expect, it } from "vitest";

import { chunkTranscript } from "../../src/notes/ai/meetingChunk";

describe("chunkTranscript", () => {
  it("returns no chunks for empty input", () => {
    expect(chunkTranscript("", { budget: 10 })).toEqual([]);
  });

  it("is lossless with no overlap: concatenation reconstructs the input", () => {
    const text = "alpha beta gamma delta epsilon zeta";
    const chunks = chunkTranscript(text, { budget: 12 });
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("never splits a word", () => {
    const words = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const text = words.join(" ");
    const chunks = chunkTranscript(text, { budget: 8 });
    for (const word of words) {
      expect(chunks.some((c) => c.text.split(/\s+/).includes(word))).toBe(true);
    }
  });

  it("emits a single over-budget word as its own chunk rather than splitting it", () => {
    const long = "x".repeat(50);
    const text = `short ${long} tail`;
    const chunks = chunkTranscript(text, { budget: 10 });
    expect(chunks.some((c) => c.text.includes(long))).toBe(true);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
  });

  it("overlaps whole tokens and still covers the whole input", () => {
    const text = "one two three four five six seven eight";
    const chunks = chunkTranscript(text, { budget: 12, overlap: 5 });
    let searchFrom = 0;
    let prevEnd = 0;
    let maxEnd = 0;
    let sawOverlap = false;
    for (const chunk of chunks) {
      const at = text.indexOf(chunk.text, searchFrom);
      expect(at).toBeGreaterThanOrEqual(0);
      if (at < prevEnd) sawOverlap = true;
      maxEnd = Math.max(maxEnd, at + chunk.text.length);
      prevEnd = at + chunk.text.length;
      searchFrom = at + 1;
    }
    expect(maxEnd).toBe(text.length);
    expect(sawOverlap).toBe(true);
  });

  it("is deterministic", () => {
    const text = "a b c d e f g h i j k l";
    expect(chunkTranscript(text, { budget: 7 })).toEqual(
      chunkTranscript(text, { budget: 7 }),
    );
  });
});
