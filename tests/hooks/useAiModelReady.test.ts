// @vitest-environment jsdom
//
// `useAiModelReady` (voice-to-text MYND-552 task 4): the device-local model-path
// readiness probe, now role-parameterized. Pins the transcription-role behaviour
// the transcribe surfaces depend on — ready / not-ready / disabled — plus the
// AI-free-build degrade-to-false path. The `ai-model-store` seam is mocked so no
// Tauri command is invoked.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const loadModelPathMock = vi.fn();

vi.mock("../../src/lib/ai-model-store", () => ({
  loadModelPath: (...args: unknown[]) => loadModelPathMock(...args),
}));

import { useAiModelReady } from "../../src/hooks/useAiModelReady";

afterEach(() => {
  loadModelPathMock.mockReset();
});

describe("useAiModelReady (transcription role)", () => {
  it("stays null and never probes when disabled", () => {
    const { result } = renderHook(() => useAiModelReady(false, "transcription"));
    expect(result.current).toBe(null);
    expect(loadModelPathMock).not.toHaveBeenCalled();
  });

  it("reports READY (true) when a transcription model path is recorded", async () => {
    loadModelPathMock.mockResolvedValue("/models/whisper-base.safetensors");
    const { result } = renderHook(() => useAiModelReady(true, "transcription"));
    await waitFor(() => expect(result.current).toBe(true));
    expect(loadModelPathMock).toHaveBeenCalledWith("transcription");
  });

  it("reports NOT-READY (false) when no transcription model is set", async () => {
    loadModelPathMock.mockResolvedValue(null);
    const { result } = renderHook(() => useAiModelReady(true, "transcription"));
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("degrades to false (never throws) on a missing command / AI-free build", async () => {
    loadModelPathMock.mockRejectedValue(new Error("command not found"));
    const { result } = renderHook(() => useAiModelReady(true, "transcription"));
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("defaults to the generation role when none is passed (unchanged callers)", async () => {
    loadModelPathMock.mockResolvedValue("/models/qwen.gguf");
    const { result } = renderHook(() => useAiModelReady(true));
    await waitFor(() => expect(result.current).toBe(true));
    expect(loadModelPathMock).toHaveBeenCalledWith("generation");
  });
});
