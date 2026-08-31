// normalizeTranscribeError — the single boundary that maps a serialized
// `EngineError` (the transcribe command's IPC rejection) to a per-cause
// `TranscribeErrorKind` (MYND-591). Every downstream surface switches on that
// kind, so this mapping is where "the failure tells the truth" starts.

import { describe, expect, it, vi } from "vitest";

// transcribe.ts imports the platform seam at module load; stub the Tauri entry
// point so this pure-mapping test never touches IPC.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
  convertFileSrc: (s: string) => s,
}));

import { normalizeTranscribeError } from "../../src/lib/transcribe";

describe("normalizeTranscribeError (MYND-591)", () => {
  it("maps each bare PascalCase EngineError variant to its cause", () => {
    expect(normalizeTranscribeError("FeatureOff").kind).toBe("feature_off");
    expect(normalizeTranscribeError("VaultLocked").kind).toBe("vault_locked");
    expect(normalizeTranscribeError("NoModel").kind).toBe("no_model");
    expect(normalizeTranscribeError("ModelLoadFailed").kind).toBe("model_load_failed");
    expect(normalizeTranscribeError("AudioTooLong").kind).toBe("too_long");
  });

  it("accepts the defensive snake_case { kind } object shape", () => {
    expect(normalizeTranscribeError({ kind: "feature_off" }).kind).toBe("feature_off");
    expect(normalizeTranscribeError({ kind: "vault_locked" }).kind).toBe("vault_locked");
    expect(normalizeTranscribeError({ kind: "no_model" }).kind).toBe("no_model");
    expect(normalizeTranscribeError({ kind: "model_load_failed" }).kind).toBe(
      "model_load_failed",
    );
    expect(normalizeTranscribeError({ kind: "audio_too_long" }).kind).toBe(
      "too_long",
    );
  });

  it("maps legacy NotReady (either casing) to no_model", () => {
    // A pre-MYND-591 backend collapsed every cause into NotReady, whose copy
    // said "select a model" — so the closest surviving cause is no_model.
    expect(normalizeTranscribeError("NotReady").kind).toBe("no_model");
    expect(normalizeTranscribeError({ kind: "not_ready" }).kind).toBe("no_model");
  });

  it("degrades every unrecognized rejection to failed", () => {
    expect(normalizeTranscribeError("TranscriptionFailed").kind).toBe("failed");
    expect(normalizeTranscribeError("InferenceFailed").kind).toBe("failed");
    expect(normalizeTranscribeError("").kind).toBe("failed");
    expect(normalizeTranscribeError(null).kind).toBe("failed");
    expect(normalizeTranscribeError(undefined).kind).toBe("failed");
    expect(normalizeTranscribeError({ nope: 1 }).kind).toBe("failed");
    expect(normalizeTranscribeError(42).kind).toBe("failed");
  });
});
