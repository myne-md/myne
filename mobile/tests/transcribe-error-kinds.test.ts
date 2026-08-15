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
  // Both shapes, because the serialized `EngineError` reaches the WebView either
  // as a bare variant name or as a `{ kind }` object carrying the snake_case tag
  // from `EngineError::kind()`, and the two halves are written in different
  // files. A mapping that handled only one would fail exactly on whichever the
  // runtime actually sends.
  it("maps the bare variant name AudioTooLong to too_long", async () => {
    expect(await kindFor("AudioTooLong")).toBe("too_long");
  });

  it("maps the { kind } object form audio_too_long to too_long", async () => {
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
