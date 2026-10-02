// Idle-debounce trigger + content-hash cache for the auto-tag pipeline
// (on-device-tag-suggestion MYND-651 task 5).
//
// Fake timers throughout: the trigger's whole point is that it fires a
// configurable interval AFTER the content settles, so "did it wait" and "did it
// coalesce" are the assertions. `suggest` is a stub standing in for the
// `plugin:local-inference|suggest_tags` seam.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_DEFERRED_RETRIES,
  TAG_SUGGESTION_DEBOUNCE_MS,
  createTagSuggestionTrigger,
  hashTagPromptInput,
} from "../../src/notes/ai/tagSuggestionTrigger";
import { TAG_PROMPT_BODY_CHARS } from "../../src/notes/ai/suggestTags";
import type { TagSuggestion } from "../../src/notes/ai/tagRanker";

const DEBOUNCE = 50;

interface Harness {
  suggest: ReturnType<typeof vi.fn>;
  results: { noteId: string; suggestions: TagSuggestion[] }[];
  trigger: ReturnType<typeof createTagSuggestionTrigger>;
}

function harness(
  opts: {
    reply?: string;
    excluded?: readonly string[];
    existingTags?: readonly string[];
  } = {},
): Harness {
  const suggest = vi.fn().mockResolvedValue(opts.reply ?? "rust, crypto");
  const results: { noteId: string; suggestions: TagSuggestion[] }[] = [];
  const trigger = createTagSuggestionTrigger({
    suggest: (args) => suggest(args) as Promise<string>,
    existingTags: () => Promise.resolve(opts.existingTags ?? []),
    excludedFolders: () => opts.excluded ?? [],
    onResult: (r) => results.push(r),
    debounceMs: DEBOUNCE,
  });
  return { suggest, results, trigger };
}

/** Advance past the debounce and flush the pass's awaited microtasks. */
async function settle(extraTicks = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(DEBOUNCE + 1);
  for (let i = 0; i < extraTicks; i++) {
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 1);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("hashTagPromptInput", () => {
  it("is stable for identical content and differs for changed content", () => {
    expect(hashTagPromptInput("a note")).toBe(hashTagPromptInput("a note"));
    expect(hashTagPromptInput("a note")).not.toBe(hashTagPromptInput("a note!"));
  });

  it("ignores content beyond the prompt window (it cannot change the answer)", () => {
    const head = "x".repeat(TAG_PROMPT_BODY_CHARS);
    expect(hashTagPromptInput(`${head}tail`)).toBe(hashTagPromptInput(`${head}TAIL`));
  });

  it("does not carry the note text itself (RAM-only digest, not a copy)", () => {
    expect(hashTagPromptInput("secret plaintext")).not.toContain("secret");
  });
});

describe("createTagSuggestionTrigger", () => {
  it("waits the debounce interval, then runs exactly one pass", async () => {
    const h = harness();
    h.trigger.schedule({ noteId: "n1", noteBody: "body", noteFolder: "Notes/" });

    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    expect(h.suggest).not.toHaveBeenCalled();

    await settle();
    expect(h.suggest).toHaveBeenCalledTimes(1);
    expect(h.suggest.mock.calls[0][0].noteId).toBe("n1");
    expect(h.results).toEqual([
      {
        noteId: "n1",
        suggestions: [
          { tag: "rust", isNew: true },
          { tag: "crypto", isNew: true },
        ],
      },
    ]);
  });

  it("coalesces rapid edits into a single pass over the settled content", async () => {
    const h = harness();
    for (const body of ["a", "ab", "abc"]) {
      h.trigger.schedule({ noteId: "n1", noteBody: body, noteFolder: "" });
      await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    }
    expect(h.suggest).not.toHaveBeenCalled();

    await settle();
    expect(h.suggest).toHaveBeenCalledTimes(1);
    expect(h.suggest.mock.calls[0][0].prompt).toContain("abc");
  });

  it("serves the content-hash cache on re-open, without a second model call", async () => {
    const h = harness();
    h.trigger.schedule({ noteId: "n1", noteBody: "body", noteFolder: "" });
    await settle();
    expect(h.suggest).toHaveBeenCalledTimes(1);

    // Switch away, then back to the SAME content.
    h.trigger.schedule({ noteId: "n2", noteBody: "other", noteFolder: "" });
    await settle();
    expect(h.suggest).toHaveBeenCalledTimes(2);

    h.trigger.schedule({ noteId: "n1", noteBody: "body", noteFolder: "" });
    expect(h.suggest).toHaveBeenCalledTimes(2); // cache hit — no timer, no call
    expect(h.results.at(-1)).toEqual({
      noteId: "n1",
      suggestions: [
        { tag: "rust", isNew: true },
        { tag: "crypto", isNew: true },
      ],
    });
  });

  it("re-runs when the content actually changes", async () => {
    const h = harness();
    h.trigger.schedule({ noteId: "n1", noteBody: "body", noteFolder: "" });
    await settle();
    h.trigger.schedule({ noteId: "n1", noteBody: "body changed", noteFolder: "" });
    await settle();
    expect(h.suggest).toHaveBeenCalledTimes(2);
  });

  it("carries only the PROMPT WINDOW into a pending pass, never the whole body", async () => {
    // The timer closure outlives the debounce and then a multi-second model
    // call; pinning the note plaintext there is what property 2 rules out.
    const h = harness();
    const tail = "TAIL-BEYOND-THE-WINDOW";
    const body = `${"x".repeat(TAG_PROMPT_BODY_CHARS)}${tail}`;
    h.trigger.schedule({ noteId: "n1", noteBody: body, noteFolder: "" });
    await settle();
    const prompt = h.suggest.mock.calls[0]![0].prompt;
    expect(prompt).not.toContain(tail);
  });

  it("produces no suggestions and never calls the model for an excluded folder", async () => {
    const h = harness({ excluded: ["Private/"] });
    h.trigger.schedule({
      noteId: "n1",
      noteBody: "secret",
      noteFolder: "Private/Journal/",
    });
    await settle();
    expect(h.suggest).not.toHaveBeenCalled();
    expect(h.results).toEqual([{ noteId: "n1", suggestions: [] }]);
  });

  it("retries a deferred pass on the next tick and never caches it", async () => {
    const h = harness();
    h.suggest
      .mockRejectedValueOnce({ kind: "deferred" })
      .mockResolvedValueOnce("rust");

    h.trigger.schedule({ noteId: "n1", noteBody: "body", noteFolder: "" });
    await settle();
    expect(h.suggest).toHaveBeenCalledTimes(1);
    expect(h.results).toEqual([]); // deferred is not an answer

    await settle();
    expect(h.suggest).toHaveBeenCalledTimes(2);
    expect(h.results).toEqual([{ noteId: "n1", suggestions: [{ tag: "rust", isNew: true }] }]);
  });

  // ai-provider-seam task 11. `EngineError::Deferred` exists only because ONE
  // compute lock exists; a backend that serializes model work out of process
  // has none and can never produce it (`Backend::serializes_compute` declares
  // which do). So on such a backend the `pass.deferred` branch above is dead
  // code — and the caching decision sits immediately downstream of it.
  //
  // The concern was that results would be cached on a path only ever exercised
  // alongside a live deferral signal. They are not: the deferred branch
  // `return`s, so the cache line is reached exactly on the non-deferred path,
  // which is the only path such a backend ever takes. Pinned here so the
  // reasoning is not re-derived — and so a future refactor that moves the
  // cache write above the deferral branch fails loudly instead of caching a
  // note the model never looked at.
  it("caches and emits normally on a backend that can never defer", async () => {
    const h = harness();
    // No `deferred` rejection anywhere in this cycle — the shape of a
    // non-serializing backend.
    h.suggest.mockResolvedValue("rust, crypto");

    h.trigger.schedule({ noteId: "n1", noteBody: "body", noteFolder: "" });
    await settle();
    expect(h.suggest).toHaveBeenCalledTimes(1);
    expect(h.results).toHaveLength(1);

    // Re-scheduling the same content must hit the cache, not the engine —
    // which is what proves the result was actually cached rather than merely
    // emitted.
    h.trigger.schedule({ noteId: "n1", noteBody: "body", noteFolder: "" });
    await settle();
    expect(h.suggest).toHaveBeenCalledTimes(1);
    expect(h.results).toHaveLength(2);
  });

  it("gives up after a bounded number of deferrals rather than spinning", async () => {
    const h = harness();
    h.suggest.mockRejectedValue({ kind: "deferred" });
    h.trigger.schedule({ noteId: "n1", noteBody: "body", noteFolder: "" });
    await settle(8);
    // One pass + exactly MAX_DEFERRED_RETRIES re-arms, then silence.
    expect(h.suggest).toHaveBeenCalledTimes(1 + MAX_DEFERRED_RETRIES);
    expect(h.results).toEqual([]);
  });

  it("swallows an engine failure without caching or emitting", async () => {
    const h = harness();
    h.suggest.mockRejectedValueOnce({ kind: "failed" }).mockResolvedValueOnce("rust");
    h.trigger.schedule({ noteId: "n1", noteBody: "body", noteFolder: "" });
    await settle();
    expect(h.results).toEqual([]);

    // Not cached: the same content is re-tried on the next schedule.
    h.trigger.schedule({ noteId: "n1", noteBody: "body", noteFolder: "" });
    await settle();
    expect(h.suggest).toHaveBeenCalledTimes(2);
    expect(h.results).toHaveLength(1);
  });

  it("drops an in-flight result after cancel() (note closed / vault locked)", async () => {
    const h = harness();
    let release: (v: string) => void = () => {};
    h.suggest.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    h.trigger.schedule({ noteId: "n1", noteBody: "body", noteFolder: "" });
    await settle();
    h.trigger.cancel();
    release("rust");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.results).toEqual([]);
  });

  it("drops a stale result when the note switched mid-flight", async () => {
    const h = harness();
    let release: (v: string) => void = () => {};
    h.suggest.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    h.trigger.schedule({ noteId: "n1", noteBody: "body", noteFolder: "" });
    await settle();
    h.trigger.schedule({ noteId: "n2", noteBody: "other", noteFolder: "" });
    release("stale");
    await settle();
    expect(h.results.map((r) => r.noteId)).toEqual(["n2"]);
  });

  it("defaults to the shared debounce constant when none is given", async () => {
    // Construct the trigger through the DEFAULT path (no `debounceMs`), which
    // `harness` never does, and observe the interval by its effect: nothing
    // before the shared constant, one pass at it.
    const suggest = vi.fn().mockResolvedValue("rust");
    const trigger = createTagSuggestionTrigger({
      suggest: (args) => suggest(args) as Promise<string>,
      existingTags: () => Promise.resolve([]),
      excludedFolders: () => [],
      onResult: () => {},
    });
    trigger.schedule({ noteId: "n1", noteBody: "body", noteFolder: "" });
    await vi.advanceTimersByTimeAsync(TAG_SUGGESTION_DEBOUNCE_MS - 1);
    expect(suggest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suggest).toHaveBeenCalledTimes(1);
  });
});
