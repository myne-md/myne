import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri IPC bridge so a rejection can be shaped exactly as the backend
// serializes one. The unit under test is `normalizeTranscribeError`, which is
// module-private on purpose, so it is driven through the exported call path
// rather than widened into the public surface just to be testable.
const invoke = vi.fn(async () => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: class {
    onmessage: unknown = null;
  },
}));

import { startTranscription } from "../src/lib/transcribe";

beforeEach(() => invoke.mockClear());

/** Reject the transcribe invoke with `raw` and return the normalized kind. */
async function kindFor(raw: unknown): Promise<string> {
  invoke.mockRejectedValueOnce(raw);
  try {
    await startTranscription("att-1").done;
  } catch (e) {
    return (e as { kind: string }).kind;
  }
  throw new Error("expected the transcription to reject");
}

describe("transcribe error normalization (myne#485)", () => {
  // Both shapes, and only one of them ships today. `EngineError` derives a plain
  // `Serialize` with no `#[serde(tag)]`, so a fieldless variant reaches the
  // WebView as the bare string `"AudioTooLong"`. Nothing emits the snake_case
  // `{ kind }` form: `EngineError::kind()` is `#[allow(dead_code)]` and its one
  // wrapper has no caller. The `{ kind }` case below is kept as defence against
  // a future `#[serde(tag = "kind")]`, and is labelled that way rather than as a
  // runtime shape, because a comment asserting both are real is what the next
  // reader would trust.
  it("maps the bare variant name AudioTooLong to too_long", async () => {
    expect(await kindFor("AudioTooLong")).toBe("too_long");
  });

  it("also maps the { kind } object form, which nothing emits yet", async () => {
    expect(await kindFor({ kind: "audio_too_long" })).toBe("too_long");
  });

  it("still maps NotReady and its snake_case tag to not_ready", async () => {
    expect(await kindFor("NotReady")).toBe("not_ready");
    expect(await kindFor({ kind: "not_ready" })).toBe("not_ready");
  });

  it("degrades anything else to failed", async () => {
    // The catch-all has to stay a catch-all: a variant this build has never
    // heard of must not silently read as "too long" and suppress the retry the
    // user might genuinely need.
    expect(await kindFor("TranscriptionFailed")).toBe("failed");
    expect(await kindFor({ kind: "some_future_variant" })).toBe("failed");
    expect(await kindFor(new Error("boom"))).toBe("failed");
  });
});
