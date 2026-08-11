// The auto-tag IPC seam (on-device-tag-suggestion MYND-651 task 5).
//
// Two things nothing else can catch. The **command name and argument shape**:
// `suggest_tags` is a different command from `infer` precisely because it runs
// the bundled tag model behind the host-side gate, and a typo here is invisible
// until a user with the feature on gets silence. And the **error normalization**:
// `Deferred` is not a failure — the whole cache rule downstream ("never cache a
// deferral") hangs on it being told apart from an engine error.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../../src/platform/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args) as Promise<unknown>,
}));

async function seam() {
  return await import("../../src/lib/ai-tags");
}

beforeEach(() => {
  invoke.mockReset();
  vi.resetModules();
});

describe("suggestTagsForNote", () => {
  it("calls the dedicated tag command with the note id and prompt", async () => {
    invoke.mockResolvedValue("rust, crypto");
    const { suggestTagsForNote } = await seam();

    await expect(
      suggestTagsForNote({ noteId: "note-1", prompt: "p" }),
    ).resolves.toBe("rust, crypto");
    expect(invoke).toHaveBeenCalledWith("plugin:local-inference|suggest_tags", {
      noteId: "note-1",
      prompt: "p",
    });
  });

  it("normalizes the host's Deferred rejection to a non-failure kind", async () => {
    invoke.mockRejectedValue("Deferred");
    const { isDeferredTagSuggestion, suggestTagsForNote } = await seam();

    await expect(
      suggestTagsForNote({ noteId: "n", prompt: "p" }),
    ).rejects.toEqual({ kind: "deferred" });
    await suggestTagsForNote({ noteId: "n", prompt: "p" }).catch((e: unknown) => {
      expect(isDeferredTagSuggestion(e)).toBe(true);
    });
  });

  it("normalizes NotReady (AI off / no bundled weights) to not_ready", async () => {
    invoke.mockRejectedValue("NotReady");
    const { suggestTagsForNote } = await seam();
    await expect(suggestTagsForNote({ noteId: "n", prompt: "p" })).rejects.toEqual({
      kind: "not_ready",
    });
  });

  it("degrades anything unrecognized to failed, never to deferred", async () => {
    // A deferral means "the note was never looked at, ask again" — inventing one
    // from an unknown value would suppress a real failure forever.
    invoke.mockRejectedValue({ some: "unexpected shape" });
    const { isDeferredTagSuggestion, suggestTagsForNote } = await seam();
    const err = await suggestTagsForNote({ noteId: "n", prompt: "p" }).catch(
      (e: unknown) => e,
    );
    expect(err).toEqual({ kind: "failed" });
    expect(isDeferredTagSuggestion(err)).toBe(false);
  });

  it("isTagSuggestError rejects values that merely have a kind", async () => {
    const { isTagSuggestError } = await seam();
    expect(isTagSuggestError({ kind: "deferred" })).toBe(true);
    expect(isTagSuggestError({ kind: "something-else" })).toBe(false);
    expect(isTagSuggestError("deferred")).toBe(false);
    expect(isTagSuggestError(null)).toBe(false);
  });
});

// `tagModelAvailable` was REMOVED in myne#191 task 1, and its three tests with
// it. It was a `catch → false` probe with no production caller left: the panel
// reads the one capability report (SYNC-5), which names the cause instead of
// collapsing every rejection into the same boolean. Nothing replaced these —
// the behaviour they pinned is now pinned by `tests/lib/aiCapability.test.ts`.
