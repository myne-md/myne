// @vitest-environment jsdom
//
// Note titles from a note's own content (myne-md/myne#848).
//
// Five properties, and the third is the one a reviewer should check the mocking
// for:
//
//   1. no local generation model means no model call AT ALL, not a call that
//      fails, `inferAmbient` is asserted uncalled, so a future "just try it"
//      refactor is caught here. It matters more here than for a conversation
//      title: the prompt is the note's whole body;
//   2. **the title is asked for on the AMBIENT class**: the host refuses a
//      remote backend for ambient (`EngineError::RemoteBarred`,
//      `core/src/inference/state.rs::ambient_requests_are_refused_a_remote_backend`),
//      and `infer`, the class that CAN be remote, is asserted never called;
//   3. the FRONTMATTER is not in the prompt. It is bookkeeping rather than
//      content, and it carries the CURRENT title: a prompt that included it gets
//      the old title back, which is the one answer this action must not produce;
//   4. every ending is a value, not a throw, the caller is a menu item that owes
//      a different sentence to "no model here" than to "the model said nothing";
//   5. nothing is written here, and no body leaves this module. The title goes
//      back to the caller, because a rename is §8.3's transactional batch rather
//      than a title write, and the CALLER reads the body at the moment it writes
//      it (review finding: the body read before a generation this slow is stale
//      by the time the rename lands).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadModelPath, mockInferAmbient, mockInfer, mockNoteRead } =
  vi.hoisted(() => ({
    mockLoadModelPath: vi.fn(),
    mockInferAmbient: vi.fn(),
    mockInfer: vi.fn(),
    mockNoteRead: vi.fn(),
  }));

vi.mock("../../src/lib/ai-model-store", () => ({
  loadModelPath: (...a: unknown[]) => mockLoadModelPath(...a),
}));

vi.mock("../../src/lib/writing-assistant", () => ({
  infer: (...a: unknown[]) => mockInfer(...a),
  inferAmbient: (...a: unknown[]) => mockInferAmbient(...a),
}));

vi.mock("../../src/notes/readNote", () => ({
  noteRead: (...a: unknown[]) => mockNoteRead(...a),
}));

import {
  NOTE_TITLE_PROMPT_INPUT_MAX_USVS,
  buildNoteTitlePrompt,
  generateNoteTitle,
} from "../../src/notes/ai/noteTitle";

const NOTE = [
  "---",
  "title: Old title",
  "tags: [project]",
  "---",
  "",
  "The mitochondria is the powerhouse of the cell, which is what this note is about.",
].join("\n");

beforeEach(() => {
  mockLoadModelPath.mockReset().mockResolvedValue("/models/qwen.gguf");
  mockInferAmbient.mockReset().mockResolvedValue("Cell biology");
  mockInfer.mockReset();
  mockNoteRead.mockReset().mockResolvedValue(NOTE);
});

afterEach(() => vi.clearAllMocks());

describe("the prompt", () => {
  it("asks for a title and carries the body as data", () => {
    const prompt = buildNoteTitlePrompt("Some note body.");
    expect(prompt).toContain("Some note body.");
    expect(prompt.toLowerCase()).toContain("title only");
    // The body is embedded, not framed: the instruction ends with a blank line
    // and then the text, so a note cannot read as a continuation of it.
    expect(prompt.endsWith("Some note body.")).toBe(true);
  });

  it("caps what it carries, so a pasted essay is not the prompt", () => {
    const long = "a".repeat(NOTE_TITLE_PROMPT_INPUT_MAX_USVS + 500);
    const prompt = buildNoteTitlePrompt(long);
    expect(prompt).not.toContain("a".repeat(NOTE_TITLE_PROMPT_INPUT_MAX_USVS + 1));
    expect(prompt).toContain("a".repeat(NOTE_TITLE_PROMPT_INPUT_MAX_USVS));
  });
});

describe("generating one", () => {
  it("returns the capped title and NOT the body it was derived from", async () => {
    mockInferAmbient.mockResolvedValue('  "Cell biology"  ');
    const outcome = await generateNoteTitle("n-1", true);
    // **No `bytes`, and that is the fix rather than a simplification** (review
    // finding): the body this read is minutes-of-generation old by the time the
    // caller writes, so carrying it out let the rename overwrite whatever landed
    // in between. The caller flushes and re-reads at commit time.
    expect(outcome).toEqual({
      kind: "ready",
      // Quotes stripped, whitespace collapsed, `capGeneratedTitle`.
      title: "Cell biology",
    });
  });

  it("refuses an excluded note without reading it or asking", async () => {
    // SYNC-14: an `ai_excluded_folders` note is not sent to a model, and the
    // verdict arrives from the caller, which owns the pref.
    expect(await generateNoteTitle("n-1", false)).toEqual({ kind: "excluded" });
    expect(mockNoteRead).not.toHaveBeenCalled();
    expect(mockInferAmbient).not.toHaveBeenCalled();
    expect(mockLoadModelPath).not.toHaveBeenCalled();
  });

  it("leaves the frontmatter out of the prompt", async () => {
    await generateNoteTitle("n-1", true);
    const prompt = String(mockInferAmbient.mock.calls[0]![0]);
    expect(prompt).toContain("The mitochondria is the powerhouse");
    // Not the old title, and not the tags: a prompt carrying the current title
    // gets the current title back.
    expect(prompt).not.toContain("Old title");
    expect(prompt).not.toContain("tags:");
  });

  it("asks on the AMBIENT class, never the one that can be remote", async () => {
    await generateNoteTitle("n-1", true);
    expect(mockInferAmbient).toHaveBeenCalledTimes(1);
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("makes no model call at all when there is no local model", async () => {
    mockLoadModelPath.mockResolvedValue(null);
    expect(await generateNoteTitle("n-1", true)).toEqual({ kind: "unavailable" });
    // The whole point: not a call that failed, no call.
    expect(mockInferAmbient).not.toHaveBeenCalled();
    expect(mockNoteRead).not.toHaveBeenCalled();
  });

  it("treats a client without the local-inference command as no model", async () => {
    // The web bundle has no local engine, and a missing command is not a title
    // failure.
    mockLoadModelPath.mockRejectedValue(new Error("no such command"));
    expect(await generateNoteTitle("n-1", true)).toEqual({ kind: "unavailable" });
    expect(mockInferAmbient).not.toHaveBeenCalled();
  });

  it("says which way it failed, rather than throwing", async () => {
    mockNoteRead.mockRejectedValue(new Error("cannot decrypt"));
    expect(await generateNoteTitle("n-1", true)).toEqual({ kind: "failed" });

    mockNoteRead.mockResolvedValue(NOTE);
    mockInferAmbient.mockRejectedValue(new Error("engine busy"));
    expect(await generateNoteTitle("n-1", true)).toEqual({ kind: "failed" });

    mockInferAmbient.mockResolvedValue("   \n  ");
    expect(await generateNoteTitle("n-1", true)).toEqual({ kind: "no-title" });
  });
});
