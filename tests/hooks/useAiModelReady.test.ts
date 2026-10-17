// @vitest-environment jsdom
//
// `useAiSurfaceState` (ai-backend-degradation myne#191 task 1) — the hook that
// replaced `useAiModelReady`'s private `get_model_path` probe.
//
// The old spec pinned a device-local path probe with a `catch → false` arm, and
// what it could assert was bounded by what the hook could know: ready /
// not-ready / disabled. The report can distinguish four states, so these pin
// the distinctions instead of the boolean — including the one the old shape
// structurally could not express, "this build has no AI at all", which used to
// arrive as the same `false` as "you have not picked a model".

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const reportMock = vi.fn();

vi.mock("../../src/lib/ai-capability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ai-capability")>()),
  aiCapabilityReport: () => reportMock(),
}));

import { useAiSurfaceState } from "../../src/hooks/useAiModelReady";
import { UNCOMPILED_REPORT } from "../../src/lib/ai-capability";

const READY = {
  compiled: true,
  backendId: "candle",
  backendClass: "in_process_local",
  generation: { available: true, cause: null },
  transcription: { available: false, cause: "no_model" },
  autoTag: { available: true, cause: null },
};

afterEach(() => {
  reportMock.mockReset();
});

describe("useAiSurfaceState", () => {
  it("stays checking and never reads the host when disabled", () => {
    reportMock.mockResolvedValue(READY);
    const { result } = renderHook(() => useAiSurfaceState(false));
    expect(result.current).toEqual({ kind: "checking" });
    // A surface behind a disabled opt-in must not make the host decrypt prefs
    // and resolve a backend to answer a question nobody asked.
    expect(reportMock).not.toHaveBeenCalled();
  });

  it("reads once and reports the feature's own state", async () => {
    reportMock.mockResolvedValue(READY);
    const { result } = renderHook(() => useAiSurfaceState(true));
    await waitFor(() => expect(result.current).toEqual({ kind: "available" }));
    expect(reportMock).toHaveBeenCalledTimes(1);
  });

  it("answers per feature, not per build", async () => {
    reportMock.mockResolvedValue(READY);
    const { result } = renderHook(() => useAiSurfaceState(true, "transcription"));
    // Same report, different feature, different answer — with the host's cause
    // rather than a bare false.
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "unavailable", cause: "no_model" }),
    );
  });

  it("distinguishes a build with no AI from a build whose model is missing", async () => {
    reportMock.mockResolvedValue(UNCOMPILED_REPORT);
    const { result } = renderHook(() => useAiSurfaceState(true));
    await waitFor(() => expect(result.current).toEqual({ kind: "absent" }));
    // The distinction the old boolean could not carry: `absent` is not
    // something a user can fix by side-loading a model, and a surface that
    // tells them to pick one is lying.
    expect(result.current).not.toEqual({ kind: "unavailable", cause: null });
  });

  it("re-reads when the feature changes", async () => {
    reportMock.mockResolvedValue(READY);
    const { rerender, result } = renderHook(
      ({ feature }: { feature: "generation" | "transcription" }) =>
        useAiSurfaceState(true, feature),
      { initialProps: { feature: "generation" as "generation" | "transcription" } },
    );
    await waitFor(() => expect(result.current).toEqual({ kind: "available" }));
    rerender({ feature: "transcription" });
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "unavailable", cause: "no_model" }),
    );
  });
});
