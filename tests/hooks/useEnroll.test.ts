// @vitest-environment jsdom
//
// `useEnroll` (MYND-425 task 5): the add-device enrollment action. It wraps the
// `sync` plugin's `sync_enroll` command — taking the account number + the
// password/phrase credential per-call and handing them straight to IPC, never
// parking the secret in React state beyond the caller's controlled inputs.
//
// The Tauri `invoke` shim is mocked at the `@tauri-apps/api/core` module seam
// (same shape as `tests/notes/saveNote.test.ts`); these tests drive the hook's
// state machine — idle → pending(busy) → approved/pending/error — and assert
// the credential is forwarded to `plugin:sync|sync_enroll`. To keep secrets out
// of CI logs, no assertion *message* (the second arg to expect-style helpers)
// ever embeds the credential value; the forwarding check compares the IPC
// payload object directly so a failure prints Vitest's own diff, not our copy.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useEnroll } from "../../src/hooks/useEnroll";

const ENROLL_CMD = "plugin:sync|sync_enroll";

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  invokeMock.mockReset();
});

describe("useEnroll — initial (idle) state", () => {
  it("starts idle: not busy, no outcome, before any attempt", () => {
    const { result } = renderHook(() => useEnroll());
    expect(result.current.busy).toBe(false);
    expect(result.current.outcome).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("useEnroll — state machine transitions", () => {
  it("idle → pending(busy) → approved when the device is approved", async () => {
    // Hold the IPC open so we can observe the in-flight (busy) phase before it
    // resolves; a deferred promise gives us a hand on the transition midpoint.
    let release!: (v: { approved: boolean }) => void;
    invokeMock.mockReturnValueOnce(
      new Promise<{ approved: boolean }>((res) => {
        release = res;
      }),
    );

    const { result } = renderHook(() => useEnroll());

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.enroll("ACCT", "secret-cred", "password");
    });

    // Mid-flight: busy is true and the prior outcome was cleared.
    await waitFor(() => expect(result.current.busy).toBe(true));
    expect(result.current.outcome).toBeNull();

    await act(async () => {
      release({ approved: true });
      await pending;
    });

    expect(result.current.busy).toBe(false);
    expect(result.current.outcome).toEqual({ state: "approved" });
  });

  it("idle → pending(busy) → pending outcome when held by the approval gate", async () => {
    invokeMock.mockResolvedValueOnce({ approved: false });

    const { result } = renderHook(() => useEnroll());
    await act(async () => {
      await result.current.enroll("ACCT", "secret-cred", "password");
    });

    expect(result.current.busy).toBe(false);
    expect(result.current.outcome).toEqual({ state: "pending" });
  });

  it("idle → pending(busy) → error when the IPC rejects (no unhandled rejection)", async () => {
    // The plugin serializes a SyncDeviceError; the hook surfaces its `kind`.
    invokeMock.mockRejectedValueOnce({ kind: "Unreachable" });

    const { result } = renderHook(() => useEnroll());

    // `enroll` swallows the rejection internally — awaiting it must resolve,
    // never throw, so there is no unhandled rejection escaping the hook.
    await act(async () => {
      await expect(
        result.current.enroll("ACCT", "secret-cred", "password"),
      ).resolves.toBeUndefined();
    });

    expect(result.current.busy).toBe(false);
    expect(result.current.outcome).toEqual({ state: "error", kind: "Unreachable" });
  });

  it("maps a non-SyncDeviceError rejection to the Internal error kind", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useEnroll());
    await act(async () => {
      await result.current.enroll("ACCT", "secret-cred", "password");
    });

    expect(result.current.outcome).toEqual({ state: "error", kind: "Internal" });
  });

  it("clears a prior error before a fresh attempt (error → busy → approved)", async () => {
    const { result } = renderHook(() => useEnroll());

    // First attempt fails into the error state.
    invokeMock.mockRejectedValueOnce({ kind: "Unreachable" });
    await act(async () => {
      await result.current.enroll("ACCT", "secret-cred", "password");
    });
    expect(result.current.outcome).toEqual({ state: "error", kind: "Unreachable" });

    // Second attempt: setOutcome(null) runs before the new IPC resolves.
    invokeMock.mockResolvedValueOnce({ approved: true });
    await act(async () => {
      await result.current.enroll("ACCT", "secret-cred", "password");
    });
    expect(result.current.outcome).toEqual({ state: "approved" });
  });
});

describe("useEnroll — credential forwarding to sync_enroll", () => {
  it("forwards the account number, credential and kind to the sync_enroll command", async () => {
    invokeMock.mockResolvedValueOnce({ approved: true });

    const { result } = renderHook(() => useEnroll());
    await act(async () => {
      await result.current.enroll("MY-ACCT", "user-entered-phrase", "recovery");
    });

    // Single IPC call to the sync plugin's enroll command.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // Compare the payload object directly (no secret in any assertion message);
    // a failure surfaces via Vitest's structural diff, not our own copy.
    expect(invokeMock).toHaveBeenCalledWith(ENROLL_CMD, {
      accountNumber: "MY-ACCT",
      credential: "user-entered-phrase",
      credentialKind: "recovery",
    });
  });

  it("carries the password credentialKind through unchanged", async () => {
    invokeMock.mockResolvedValueOnce({ approved: false });

    const { result } = renderHook(() => useEnroll());
    await act(async () => {
      await result.current.enroll("MY-ACCT", "pw-cred", "password");
    });

    const [cmd, payload] = invokeMock.mock.calls[0] as [
      string,
      { accountNumber: string; credential: string; credentialKind: string },
    ];
    expect(cmd).toBe(ENROLL_CMD);
    expect(payload.accountNumber).toBe("MY-ACCT");
    expect(payload.credentialKind).toBe("password");
    // Credential is forwarded verbatim — checked via a boolean so the value is
    // never interpolated into a failure message.
    expect(payload.credential === "pw-cred").toBe(true);
  });

  it("does not retain the credential anywhere on the returned hook surface", async () => {
    invokeMock.mockResolvedValueOnce({ approved: true });

    const { result } = renderHook(() => useEnroll());
    await act(async () => {
      await result.current.enroll("MY-ACCT", "leaky-secret", "password");
    });

    // The hook hands the secret straight to IPC; the post-call public surface
    // (busy / outcome) must not stringify-contain it. Boolean assertion keeps
    // the secret out of the message even on failure.
    const surface = JSON.stringify({
      busy: result.current.busy,
      outcome: result.current.outcome,
    });
    expect(surface.includes("leaky-secret")).toBe(false);
  });
});

describe("useEnroll — reset()", () => {
  it("reset() clears the last outcome back to null", async () => {
    invokeMock.mockResolvedValueOnce({ approved: true });

    const { result } = renderHook(() => useEnroll());
    await act(async () => {
      await result.current.enroll("ACCT", "secret-cred", "password");
    });
    expect(result.current.outcome).toEqual({ state: "approved" });

    act(() => {
      result.current.reset();
    });
    expect(result.current.outcome).toBeNull();
  });
});
