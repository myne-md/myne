// Binding tests for the diagnostics seam (myne-md/myne#860, task 1).
//
// Mocks the Tauri `invoke` shim and pins the two properties that no compiler
// checks and no other gate sees:
//
//   1. the exact `plugin:diagnostics|…` command name and the argument KEY. The
//      setter sends `{ enabled }`, and Tauri matches the argument by name, so a
//      rename on either side compiles and rejects at runtime. This is the same
//      drift trap `tests/lib/prefsBindings.test.ts` exists for.
//   2. that the READ is a plain boolean round trip, because the surface treats
//      a failed read as "off": anything that throws here has to reach the
//      caller rather than being folded into a false at the seam, or the hook
//      cannot tell "the host said off" from "the host could not answer".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  diagnosticLogEnabledGet,
  diagnosticLogEnabledSet,
} from "../../src/platform/diagnostics";

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  invokeMock.mockReset();
});

describe("diagnostic-log bindings", () => {
  it("reads the flag through the plugin-qualified command", async () => {
    invokeMock.mockResolvedValue(true);
    await expect(diagnosticLogEnabledGet()).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe(
      "plugin:diagnostics|diagnostic_log_enabled_get",
    );
    // No payload: the read takes no argument, so nothing page-supplied can
    // steer it.
    expect(invokeMock.mock.calls[0][1]).toBeUndefined();
  });

  it("sends the setter's boolean under the key the host matches on", async () => {
    invokeMock.mockResolvedValue(undefined);
    await diagnosticLogEnabledSet(true);
    expect(invokeMock.mock.calls[0][0]).toBe(
      "plugin:diagnostics|diagnostic_log_enabled_set",
    );
    expect(invokeMock.mock.calls[0][1]).toEqual({ enabled: true });

    invokeMock.mockClear();
    await diagnosticLogEnabledSet(false);
    expect(invokeMock.mock.calls[0][1]).toEqual({ enabled: false });
  });

  it("lets a failed read reject rather than answering false at the seam", async () => {
    // The distinction matters: the hook renders both states as "off", but it
    // records the failure. A seam that swallowed the rejection would make the
    // surface unable to say it could not read the switch.
    invokeMock.mockRejectedValue({ kind: "io", detail: { io_error_kind: "other" } });
    await expect(diagnosticLogEnabledGet()).rejects.toEqual({
      kind: "io",
      detail: { io_error_kind: "other" },
    });
  });

  it("lets a failed write reject so the switch stays where it was", async () => {
    invokeMock.mockRejectedValue({ kind: "io", detail: { io_error_kind: "permission_denied" } });
    await expect(diagnosticLogEnabledSet(true)).rejects.toEqual({
      kind: "io",
      detail: { io_error_kind: "permission_denied" },
    });
  });
});
