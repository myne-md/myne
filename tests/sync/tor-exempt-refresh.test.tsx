// @vitest-environment jsdom
//
// The Tor posture is endpoint-aware, so every path that writes an endpoint has
// to re-read it (MYND-650 task 8).
//
// `exempt` polls on the SLOW tick (15 s) on the argument that nothing but a
// deliberate act in this same app can move it, and that every such path calls
// `refreshTorState()`. That argument was written when the toggle was the only
// input. `exempt` is a property of the ENDPOINT, so `sync_set_endpoint` and
// `sync_join_account` are inputs too — and until this test existed, neither
// screen re-read.
//
// What that cost is not cosmetic: `torPosture` checks `exempt` before the
// sidecar's phase, so a stale `exempt` also SUPPRESSES the fail-closed banner.
// A user who repointed a loopback endpoint at a remote server would read "Sync
// isn't using Tor — this address points at this device" over a server on the
// other side of the internet, with no paused-sync warning, for up to 15 s.
//
// The assertion is on the posture a consumer of `useTorState` renders, not on a
// spy over the hook module — the failure being guarded against is a UI that
// lags the endpoint, and mocking the re-read out would test the call rather than
// the consequence.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const { EndpointConfig } = await import("../../src/components/sync/EndpointConfig");
const { JoinDeviceModal } = await import("../../src/components/sync/JoinDeviceModal");
const { useTorState } = await import("../../src/hooks/useTorState");

/** Renders whatever posture the shared hook currently holds. */
function PostureProbe() {
  const { posture } = useTorState();
  return <span data-testid="probe.posture">{posture ?? "unknown"}</span>;
}

/** The endpoint this device is pointed at — flipped by the fake backend. */
let endpointIsLoopback = true;

beforeEach(() => {
  endpointIsLoopback = true;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "plugin:sync|sync_get_endpoint":
        throw new Error("unconfigured");
      case "plugin:sync|sync_set_endpoint":
        // The command that moves `exempt`: a remote server replaces the
        // loopback one, and the backend's posture answer changes with it.
        endpointIsLoopback = false;
        // `pin_source` is the only field this screen's behaviour depends on
        // (loopback exemption, not trust), and the browser-verified answer is
        // the one a `https` endpoint reports.
        return { fingerprint: null, pin_source: "platform_trust_store" };
      case "plugin:sync|sync_get_tor_state":
        return {
          enabled: true,
          state: { kind: "ready" },
          exempt: endpointIsLoopback,
        };
      case "plugin:sync|sync_join_account":
        // The other endpoint writer: a join points this device at the server it
        // was given, which moves `exempt` exactly as the endpoint screen does.
        endpointIsLoopback = false;
        return {
          device_id_hex: "aa",
          vault_id: "v1",
          pending: false,
          fingerprint: null,
        };
      default:
        // The platform probe and the post-join calls (`sync_now`, device
        // naming) — nothing this file asserts on.
        return "linux";
    }
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the Tor posture after an endpoint change", () => {
  it("re-reads when the endpoint screen repoints the server", async () => {
    render(
      <>
        <PostureProbe />
        <EndpointConfig />
      </>,
    );

    // Tor mode on + a loopback endpoint ⇒ exempt, and exempt is on the slow
    // tick. Nothing below advances a clock.
    await waitFor(() =>
      expect(screen.getByTestId("probe.posture").textContent).toBe("exempt"),
    );

    fireEvent.change(screen.getByTestId("sync.endpoint-input"), {
      target: { value: "https://sync.example" },
    });
    fireEvent.click(screen.getByTestId("sync.endpoint-connect"));

    // The tunnel is real now and the banner-suppressing posture is gone —
    // without waiting out the idle poll.
    await waitFor(() =>
      expect(screen.getByTestId("probe.posture").textContent).toBe("active"),
    );
  });

  it("re-reads when a join points this device at a server", async () => {
    render(
      <>
        <PostureProbe />
        <JoinDeviceModal onCancel={vi.fn()} onJoined={vi.fn()} onRecovering={vi.fn()} />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("probe.posture").textContent).toBe("exempt"),
    );

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

    await waitFor(() =>
      expect(screen.getByTestId("probe.posture").textContent).toBe("active"),
    );
  });

  it("does not re-read when the endpoint write was refused", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_get_endpoint") throw new Error("unconfigured");
      // A TLS refusal writes no endpoint, so the Tor posture cannot change.
      if (cmd === "plugin:sync|sync_set_endpoint") throw { kind: "TlsFailure" };
      if (cmd === "plugin:sync|sync_get_tor_state")
        return { enabled: true, state: { kind: "ready" }, exempt: true };
      return undefined;
    });

    render(
      <>
        <PostureProbe />
        <EndpointConfig />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("probe.posture").textContent).toBe("exempt"),
    );

    const before = invokeMock.mock.calls.filter(
      (c) => c[0] === "plugin:sync|sync_get_tor_state",
    ).length;
    fireEvent.change(screen.getByTestId("sync.endpoint-input"), {
      target: { value: "https://sync.example" },
    });
    fireEvent.click(screen.getByTestId("sync.endpoint-connect"));
    await screen.findByTestId("sync.endpoint-msg");
    expect(screen.getByTestId("sync.endpoint-msg").textContent).toContain("HTTPS certificate");

    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "plugin:sync|sync_get_tor_state").length,
    ).toBe(before);
  });
});
