// @vitest-environment jsdom
//
// The diagnostics hook's two READ failures (myne-md/myne#860 review).
//
// Both fold to the safe state (the switch shows off, no crash row), which is the
// direction in which nothing is written. What neither may do is stay SILENT:
//
//   1. a refused flag read must be recorded as a READ failure, because the row's
//      change sentence ("Myne could not change that setting") describes an action
//      the user never took, with the switch still off and untouched;
//   2. a refused crash-record read must be distinguishable from the host
//      answering "no record", because a no-consent artefact's presence may not be
//      hidden behind a read that never landed.
//
// Neither is visible to a compiler: both are a `catch` that returns a value, and
// before this change both returned the benign one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

// `vi.hoisted` because the mock factories below are hoisted above every top
// level `const`: without it the factories close over bindings that do not exist
// yet and vitest refuses the module.
const h = vi.hoisted(() => ({
  diagnosticLogEnabledGet: vi.fn(),
  diagnosticLogEnabledSet: vi.fn(),
  crashRecordState: vi.fn(),
  crashRecordClear: vi.fn(),
  revealLogsFolder: vi.fn(),
  reportManifest: vi.fn(),
  saveReport: vi.fn(),
}));

vi.mock("../../src/platform/capabilities", () => ({ has: () => true }));
vi.mock("../../src/platform/diagnostics", () => ({
  diagnosticLogEnabledGet: h.diagnosticLogEnabledGet,
  diagnosticLogEnabledSet: h.diagnosticLogEnabledSet,
  crashRecordState: h.crashRecordState,
  crashRecordClear: h.crashRecordClear,
  revealLogsFolder: h.revealLogsFolder,
  reportManifest: h.reportManifest,
  saveReport: h.saveReport,
}));
vi.mock("../../src/platform/dialog", () => ({ save: vi.fn() }));

import { useDiagnostics } from "../../src/hooks/useDiagnostics";

beforeEach(() => {
  vi.resetAllMocks();
  h.diagnosticLogEnabledGet.mockResolvedValue(false);
  h.diagnosticLogEnabledSet.mockResolvedValue(undefined);
  h.crashRecordState.mockResolvedValue(null);
  h.reportManifest.mockResolvedValue({
    log_files: 0,
    total_bytes: 0,
    crash_at_epoch_seconds: null,
  });
});

afterEach(() => cleanup());

/** Mount the hook and wait for the initial reads to settle. */
async function mount() {
  const hook = renderHook(() => useDiagnostics());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe("useDiagnostics — a failed flag read", () => {
  it("is recorded as a READ failure, not the change failure", async () => {
    h.diagnosticLogEnabledGet.mockRejectedValueOnce({
      kind: "Io",
      detail: { io_error_kind: "PermissionDenied" },
    });
    const { result } = await mount();
    expect(result.current.error).toEqual({ source: "read" });
    // The switch still folds to off, which is the direction in which nothing is
    // written.
    expect(result.current.enabled).toBe(false);
  });

  it("leaves the change sentence to a failed write", async () => {
    h.diagnosticLogEnabledSet.mockRejectedValueOnce({
      kind: "Io",
      detail: { io_error_kind: "Other" },
    });
    const { result } = await mount();
    await act(async () => {
      await result.current.setEnabled(true);
    });
    expect(result.current.error).toEqual({
      source: "change",
      error: { kind: "Io", detail: { io_error_kind: "Other" } },
    });
  });

  it("clears a read failure when a change is attempted", async () => {
    h.diagnosticLogEnabledGet.mockRejectedValueOnce({
      kind: "Io",
      detail: { io_error_kind: "Other" },
    });
    const { result } = await mount();
    expect(result.current.error).toEqual({ source: "read" });
    await act(async () => {
      await result.current.setEnabled(true);
    });
    expect(result.current.error).toBeNull();
  });
});

describe("useDiagnostics — a failed crash-record read", () => {
  it("is recorded rather than folded into no record", async () => {
    h.crashRecordState.mockRejectedValueOnce(new Error("refused"));
    const { result } = await mount();
    expect(result.current.crash).toBeNull();
    expect(result.current.crashReadFailed).toBe(true);
  });

  it("does not mark a host-answered empty record as a read failure", async () => {
    h.crashRecordState.mockResolvedValueOnce(null);
    const { result } = await mount();
    expect(result.current.crash).toBeNull();
    expect(result.current.crashReadFailed).toBe(false);
  });

  it("records a refused read taken by the post-change refresh", async () => {
    const { result } = await mount();
    h.crashRecordState.mockRejectedValueOnce(new Error("refused"));
    await act(async () => {
      await result.current.setEnabled(true);
    });
    expect(result.current.crashReadFailed).toBe(true);
  });
});
