// @vitest-environment jsdom
//
// The join modal's half of the out-of-band fingerprint gate (MYND-650 task 9).
//
// `EndpointConfig` is the door for a device that already has a vault; this is
// the door for a fresh one, and task 5 wired the same backend refusal into both.
// What is asserted here is the part that differs: on this surface DECLINING is
// an abort of the whole join, and the modal's own submit/cancel footer must
// stand down while the gate owns the decision — otherwise the card carries two
// buttons that both mean "add device" at the moment it is asking the user to
// stop and check something.
//
// The refused attempt wrote nothing (no endpoint, no pin, no vault container —
// `pin_confirm`'s contract), which is why declining is just `onCancel` and not
// a rollback.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { JoinDeviceModal } from "../../src/components/sync/JoinDeviceModal";

const EXPECTED = "a".repeat(64);

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Fill the form and press "Add device". */
function submitForm() {
  fireEvent.change(screen.getByTestId("join.server-input"), {
    target: { value: "https://sync.example" },
  });
  fireEvent.change(screen.getByTestId("join.account-input"), {
    target: { value: "MY-ABCD-EFGH-JKLM-NPQR-STVW" },
  });
  fireEvent.change(screen.getByTestId("join.password-input"), {
    target: { value: "correct horse battery staple" },
  });
  fireEvent.click(screen.getByTestId("join.submit"));
}

describe("the join modal's fingerprint gate", () => {
  it("replaces the footer with confirm/decline and retries with what was typed", async () => {
    const calls: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(
      async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "plugin:sync|sync_join_account") {
          calls.push(args ?? {});
          if (!args?.confirmedFingerprint) throw { kind: "PinConfirmationRequired" };
          return {
            device_id_hex: "aa",
            vault_id: "v1",
            pending: false,
            fingerprint: null,
          };
        }
        return "linux";
      },
    );
    const onJoined = vi.fn();
    render(<JoinDeviceModal onCancel={vi.fn()} onJoined={onJoined} />);
    submitForm();

    const field = await screen.findByTestId("join.expected-fingerprint-input");
    // The footer stands down — exactly one confirm and one decline on screen.
    expect(screen.queryByTestId("join.submit")).toBeNull();
    expect(screen.queryByTestId("join.cancel")).toBeNull();

    fireEvent.change(field, { target: { value: EXPECTED } });
    fireEvent.click(screen.getByTestId("join.fingerprint-confirm"));

    await waitFor(() => expect(onJoined).toHaveBeenCalledWith("v1"));
    expect(calls).toHaveLength(2);
    expect(calls[0].confirmedFingerprint).toBeNull();
    expect(calls[1].confirmedFingerprint).toBe(EXPECTED);
  });

  it("declining aborts the join and sends nothing further", async () => {
    let joinCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_join_account") {
        joinCalls += 1;
        throw { kind: "FingerprintMismatch" };
      }
      return "linux";
    });
    const onCancel = vi.fn();
    render(<JoinDeviceModal onCancel={onCancel} onJoined={vi.fn()} />);
    submitForm();

    await screen.findByTestId("join.fingerprint-gate");
    // The mismatch message must not hand back the certificate that was served.
    expect(screen.getByTestId("join.error").textContent).toBeTruthy();
    expect(screen.queryByTestId("join.cert-fingerprint")).toBeNull();

    fireEvent.click(screen.getByTestId("join.fingerprint-decline"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(joinCalls).toBe(1);
  });
});
