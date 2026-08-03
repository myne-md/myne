// @vitest-environment jsdom
//
// #243 — the join modal's pending poll must not sit behind a full vault sync.
//
// The match code needs exactly one thing: an adopted head observation, which is
// recorded as soon as it MAC-verifies, BEFORE note bodies download. `sync_now`
// claims the approval *and* pulls the whole vault, so awaiting it before every
// fingerprint check gated a code that was already available on the entire vault
// arriving — a multi-minute "waiting for approval" on a small vault, and on a
// large one a tick that never returns, a next tick that never fires, and a
// screen that never advances. Mobile fixed this shape in MYND-537; this is the
// desktop end of it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { JoinDeviceModal } from "../../src/components/sync/JoinDeviceModal";

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** Fill the form and press "Add device", landing the modal on `pending`. */
async function reachPending() {
  fireEvent.change(screen.getByTestId("join.server-input"), {
    target: { value: "https://sync.example" },
  });
  fireEvent.change(screen.getByTestId("join.account-input"), {
    target: { value: "MY-ABCD-EFGH-JKLM-NPQR-STVW" },
  });
  fireEvent.change(screen.getByTestId("join.password-input"), {
    target: { value: "correct horse battery staple" },
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("join.submit"));
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("join modal — pending head-fingerprint poll", () => {
  it("advances to verify while sync_now is still running", async () => {
    vi.useFakeTimers();
    let syncNowStarted = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:sync|sync_join_account") {
        // Awaiting approval, no cert pin → straight to `pending`.
        return Promise.resolve({
          pending: true,
          fingerprint: null,
          device_id_hex: "bb11",
          vault_id: "vault-1",
        });
      }
      // A first sync on a large vault: it does not come back.
      if (cmd === "plugin:sync|sync_now") {
        syncNowStarted += 1;
        return new Promise(() => {});
      }
      if (cmd === "plugin:sync|sync_head_fingerprint") return Promise.resolve("K3M9-QR7T");
      return Promise.resolve(undefined);
    });

    render(<JoinDeviceModal onCancel={vi.fn()} onJoined={vi.fn()} />);
    await reachPending();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(syncNowStarted).toBe(1);
    expect(screen.queryByTestId("join.sas-fingerprint")).toBeTruthy();
  });

  it("keeps at most one sync_now in flight across ticks", async () => {
    vi.useFakeTimers();
    let syncNowStarted = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:sync|sync_join_account") {
        return Promise.resolve({
          pending: true,
          fingerprint: null,
          device_id_hex: "bb11",
          vault_id: "vault-1",
        });
      }
      if (cmd === "plugin:sync|sync_now") {
        syncNowStarted += 1;
        return new Promise(() => {});
      }
      // Still pending approval — no head adopted yet.
      if (cmd === "plugin:sync|sync_head_fingerprint") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });

    render(<JoinDeviceModal onCancel={vi.fn()} onJoined={vi.fn()} />);
    await reachPending();

    // Five ~1 s ticks of the fingerprint poll…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5200);
    });

    // …and still exactly one full sync: overlapping ones would contend for the
    // same vault.
    expect(syncNowStarted).toBe(1);
    expect(screen.queryByTestId("join.sas-fingerprint")).toBeNull();
  });
});
