import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  COMPLETION_CONTEXT_CHARS,
  aiEntryAllowed,
  buildCompletionPrompt,
  buildRewritePrompt,
  buildTitlePrompt,
  computeContinuation,
  computeRewrite,
  computeTitle,
  infer,
  resolveRewriteRange,
} from "../../src/lib/writing-assistant";

function state(doc: string, sel?: { anchor: number; head: number }): EditorState {
  return EditorState.create(sel ? { doc, selection: sel } : { doc });
}

// writing-assistant (MYND-410) task 1 — pure prompt/range cores + gating + the
// thin blocking infer wrapper (model quality NOT under test).
describe("infer wrapper", () => {
  it("calls only the sibling-1 local-inference command (no fetch, no new capability)", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("a continuation");
    const out = await infer("some prompt");
    expect(out).toBe("a continuation");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("plugin:local-inference|infer", {
      prompt: "some prompt",
    });
  });
});

describe("buildCompletionPrompt", () => {
  it("includes the preceding text and a continue instruction", () => {
    const p = buildCompletionPrompt("The quick brown fox");
    expect(p).toContain("The quick brown fox");
    expect(p.toLowerCase()).toContain("continue");
  });

  it("keeps only the tail window when the preceding text exceeds the budget", () => {
    const long = "x".repeat(COMPLETION_CONTEXT_CHARS + 500) + "TAIL";
    const p = buildCompletionPrompt(long);
    expect(p).toContain("TAIL");
    // The head is dropped: the prompt body is at most budget chars of context.
    const contextChars = Array.from(p).filter((c) => c === "x").length;
    expect(contextChars).toBeLessThanOrEqual(COMPLETION_CONTEXT_CHARS);
  });

  it("does not split a surrogate pair at the window boundary", () => {
    // A run of emoji longer than the budget; slicing must stay on code points.
    const emoji = "😀".repeat(COMPLETION_CONTEXT_CHARS + 50);
    const p = buildCompletionPrompt(emoji);
    // If a surrogate were split, the string would contain a lone U+FFFD-free
    // half; asserting round-trip integrity: every emoji in the window is intact.
    expect(p.includes("😀")).toBe(true);
    expect(p).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(p).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe("resolveRewriteRange", () => {
  it("returns the primary selection span when a range is selected", () => {
    const s = state("Hello world", { anchor: 0, head: 5 });
    expect(resolveRewriteRange(s)).toEqual({ from: 0, to: 5 });
  });

  it("returns null for an empty selection (no-op)", () => {
    const s = state("Hello world"); // bare cursor at 0
    expect(resolveRewriteRange(s)).toBeNull();
  });
});

describe("buildRewritePrompt / buildTitlePrompt", () => {
  it("rewrite prompt carries the selected text and a rewrite instruction", () => {
    const p = buildRewritePrompt("make this clearer");
    expect(p).toContain("make this clearer");
    expect(p.toLowerCase()).toContain("rewrite");
  });

  it("title prompt carries the body head and a title instruction", () => {
    const p = buildTitlePrompt("This note is about distributed systems.");
    expect(p).toContain("distributed systems");
    expect(p.toLowerCase()).toContain("title");
  });
});

describe("aiEntryAllowed (ai_enabled + ai_excluded_folders gate)", () => {
  it("allows when AI is enabled and the note is not excluded", () => {
    expect(
      aiEntryAllowed({ aiEnabled: true, noteFolder: "Work/", excludedFolders: [] }),
    ).toBe(true);
  });

  it("short-circuits when ai_enabled is off", () => {
    expect(
      aiEntryAllowed({
        aiEnabled: false,
        noteFolder: "Work/",
        excludedFolders: [],
      }),
    ).toBe(false);
  });

  it("short-circuits when the note is inside an excluded folder", () => {
    expect(
      aiEntryAllowed({
        aiEnabled: true,
        noteFolder: "Private/Journal/",
        excludedFolders: ["Private/"],
      }),
    ).toBe(false);
  });

  it("default (empty exclusion set) includes the whole vault", () => {
    expect(
      aiEntryAllowed({ aiEnabled: true, noteFolder: "", excludedFolders: [] }),
    ).toBe(true);
  });
});

describe("command orchestration cores (task 5)", () => {
  it("computeContinuation builds from the text before the cursor and returns the completion", async () => {
    // cursor after "The quick" (position 9); "brown fox" is after the cursor.
    const s = state("The quick brown fox", { anchor: 9, head: 9 });
    const infer = vi.fn().mockResolvedValue(" and lazy dog");
    const out = await computeContinuation({ state: s, infer });
    expect(out).toBe(" and lazy dog");
    const prompt = infer.mock.calls[0][0];
    expect(prompt).toContain("The quick");
    expect(prompt).not.toContain("brown fox"); // text after the cursor is excluded
  });

  it("computeRewrite returns the span + rewritten text for a selection", async () => {
    const s = state("Hello world", { anchor: 0, head: 5 });
    const infer = vi.fn().mockResolvedValue("Greetings");
    const out = await computeRewrite({ state: s, infer });
    expect(out).toEqual({ from: 0, to: 5, text: "Greetings" });
    expect(infer.mock.calls[0][0]).toContain("Hello"); // rewrites the selection
  });

  it("computeRewrite is a no-op (null) with no selection and never calls infer", async () => {
    const s = state("Hello world"); // bare cursor
    const infer = vi.fn();
    const out = await computeRewrite({ state: s, infer });
    expect(out).toBeNull();
    expect(infer).not.toHaveBeenCalled();
  });

  it("computeTitle returns the suggested title from the body", async () => {
    const infer = vi.fn().mockResolvedValue("Distributed Systems Notes");
    const out = await computeTitle({
      docText: "Notes on consensus and replication.",
      infer,
    });
    expect(out).toBe("Distributed Systems Notes");
    expect(infer.mock.calls[0][0]).toContain("consensus");
  });
});
