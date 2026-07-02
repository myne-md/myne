import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";

import {
  assembleSummarizePrompt,
  resolveSummarizeInput,
  runSummarize,
  truncateToContext,
} from "../../src/notes/ai/summarize";

function state(doc: string, sel?: { anchor: number; head: number }): EditorState {
  return EditorState.create(sel ? { doc, selection: sel } : { doc });
}

// note-summarization tasks 1 + 2 (MYND-409) — the pure input seams.
describe("resolveSummarizeInput (selection-or-whole-note)", () => {
  it("returns the selection when a non-empty range is selected", () => {
    const s = state("Hello world", { anchor: 0, head: 5 });
    expect(resolveSummarizeInput(s)).toEqual({ text: "Hello", mode: "selection" });
  });

  it("returns the whole note when nothing is selected (bare cursor)", () => {
    const s = state("Hello world");
    expect(resolveSummarizeInput(s)).toEqual({
      text: "Hello world",
      mode: "note",
    });
  });

  it("handles the empty-note edge (whole-note, empty text)", () => {
    expect(resolveSummarizeInput(state(""))).toEqual({ text: "", mode: "note" });
  });
});

describe("truncateToContext (truncate-with-honest-notice)", () => {
  it("passes text through unchanged when within budget", () => {
    expect(truncateToContext("abcde", 10)).toEqual({
      promptText: "abcde",
      truncated: false,
      summarizedChars: 5,
    });
  });

  it("is not truncated exactly at the budget boundary", () => {
    expect(truncateToContext("abcde", 5)).toEqual({
      promptText: "abcde",
      truncated: false,
      summarizedChars: 5,
    });
  });

  it("truncates to the budget prefix just over the boundary", () => {
    expect(truncateToContext("abcdef", 5)).toEqual({
      promptText: "abcde",
      truncated: true,
      summarizedChars: 5,
    });
  });

  it("never splits a surrogate pair (code-point-aware)", () => {
    // Two astral emoji (each a surrogate pair); budget 1 → exactly one emoji.
    const two = "😀😀";
    const r = truncateToContext(two, 1);
    expect(r.truncated).toBe(true);
    expect(r.summarizedChars).toBe(1);
    expect(r.promptText).toBe("😀");
    expect([...r.promptText]).toHaveLength(1);
  });
});

describe("runSummarize (orchestration through a blocking infer)", () => {
  it("resolves a selection → assembles the RAM prompt → calls infer once", async () => {
    const infer = vi.fn(async (p: string) => `SUMMARY(${p.length})`);
    const s = state("Hello world", { anchor: 0, head: 5 });
    const out = await runSummarize({ state: s, budget: 100, infer });
    expect(out.mode).toBe("selection");
    expect(out.truncated).toBe(false);
    expect(out.summarizedChars).toBe(5);
    expect(infer).toHaveBeenCalledOnce();
    // The prompt = fixed instruction + resolved text, assembled in RAM.
    expect(infer.mock.calls[0]![0]).toBe(assembleSummarizePrompt("Hello"));
    expect(out.summary).toContain("SUMMARY");
  });

  it("truncates an over-budget whole-note input before infer + reports it", async () => {
    const infer = vi.fn(async () => "ok");
    const s = state("abcdefghij"); // 10 chars, no selection → whole note
    const out = await runSummarize({ state: s, budget: 4, infer });
    expect(out.mode).toBe("note");
    expect(out.truncated).toBe(true);
    expect(out.summarizedChars).toBe(4);
    expect(infer.mock.calls[0]![0]).toBe(assembleSummarizePrompt("abcd"));
  });
});
