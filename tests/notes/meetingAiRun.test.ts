// Meeting AI task 2: the map-reduce orchestration (pure over an injected
// batch runner).
//
// The two things that matter and are asserted here: the pass is two batches
// (map then reduce) and a short or stopped batch is a cancellation, not a
// partial success. Nothing here touches a note, which is why a stop cannot
// lose data.

import { describe, expect, it, vi } from "vitest";

import { startMeetingAi } from "../../src/notes/ai/meetingRun";
import type { RunBatch } from "../../src/lib/meeting-ai";

const LONG_TRANSCRIPT = "word ".repeat(2000);

describe("startMeetingAi", () => {
  it("summarizes chunks, then reduces into parsed sections", async () => {
    const calls: string[][] = [];
    const runBatch: RunBatch = (prompts) => {
      calls.push([...prompts]);
      const outputs =
        calls.length === 1
          ? prompts.map((_, i) => `summary ${i}`)
          : ["## Summary\nAll good.\n## Action items\n- Do it"];
      return { done: Promise.resolve(outputs), stop: () => {} };
    };

    const run = startMeetingAi({
      transcript: LONG_TRANSCRIPT,
      sections: ["summary", "actionItems"],
      budget: 100,
      runBatch,
    });
    const out = await run.result;

    expect(out.cancelled).toBe(false);
    expect(out.sections.summary).toBe("All good.");
    expect(out.sections.actionItems).toBe("- Do it");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toHaveLength(1);
  });

  it("reports cancellation when the map batch comes back short", async () => {
    const runBatch: RunBatch = (prompts) => ({
      done: Promise.resolve(prompts.slice(0, 1)),
      stop: () => {},
    });

    const out = await startMeetingAi({
      transcript: LONG_TRANSCRIPT,
      sections: ["summary"],
      budget: 100,
      runBatch,
    }).result;

    expect(out.cancelled).toBe(true);
    expect(out.sections).toEqual({});
  });

  it("runs nothing for an empty transcript", async () => {
    const runBatch = vi.fn<RunBatch>();
    const out = await startMeetingAi({
      transcript: "",
      sections: ["summary"],
      runBatch,
    }).result;

    expect(out).toEqual({ sections: {}, cancelled: false });
    expect(runBatch).not.toHaveBeenCalled();
  });

  it("passes a custom instruction through to the reduce prompt", async () => {
    const seen: string[] = [];
    const runBatch: RunBatch = (prompts) => {
      seen.push(prompts[0] ?? "");
      const outputs = seen.length === 1 ? prompts.map(() => "s") : ["## Summary\nX"];
      return { done: Promise.resolve(outputs), stop: () => {} };
    };

    await startMeetingAi({
      transcript: LONG_TRANSCRIPT,
      sections: ["summary"],
      customInstruction: "CUSTOM MARKER ABC",
      budget: 100,
      runBatch,
    }).result;

    expect(seen[1]).toContain("CUSTOM MARKER ABC");
  });

  it("tree-reduces when the chunk summaries exceed the reduce budget", async () => {
    const calls: string[][] = [];
    const runBatch: RunBatch = (prompts) => {
      calls.push([...prompts]);
      // Every batch returns one large output per prompt, so the summaries stay
      // over the reduce budget until the tree reduce has condensed them.
      const outputs = prompts.map(() => "s".repeat(2000));
      return { done: Promise.resolve(outputs), stop: () => {} };
    };

    await startMeetingAi({
      transcript: "word ".repeat(20000),
      sections: ["summary"],
      budget: 100,
      runBatch,
    }).result;

    // map, then at least one condense level, then the section reduce.
    expect(calls.length).toBeGreaterThan(2);
    // The last call is the section-producing reduce: exactly one prompt.
    expect(calls[calls.length - 1]).toHaveLength(1);
  });

  it("forwards progress from the batch runner", async () => {
    const runBatch: RunBatch = (prompts, onProgress) => {
      onProgress(prompts.length, prompts.length);
      const outputs = prompts.length > 1 ? prompts.map(() => "s") : ["## Summary\nY"];
      return { done: Promise.resolve(outputs), stop: () => {} };
    };
    const progress: Array<[number, number]> = [];

    await startMeetingAi({
      transcript: LONG_TRANSCRIPT,
      sections: ["summary"],
      budget: 100,
      runBatch,
      onProgress: (done, total) => progress.push([done, total]),
    }).result;

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]![0]).toBe(progress[0]![1]);
  });
});
