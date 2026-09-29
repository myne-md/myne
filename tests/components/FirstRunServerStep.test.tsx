// @vitest-environment jsdom
//
// The first-run sync-server choice (myne-md/myne#780): a hosted door and a
// self-hosted door. The hosted door must write the shared `HOSTED_SYNC_ORIGIN`
// and no fingerprint argument at all (the retired `confirmedFingerprint` is
// gone from this call, and the endpoint's own CA verification is the backend's
// job); the self-hosted door must reveal the same `EndpointConfig` the Settings
// panel mounts.
//
// The certificate gate this file used to test, a "the pin changed" form the
// user answered by pasting the old fingerprint, was removed with pinning
// (`decisions/sync/0620`). Its replacement surface is the refusal below: an
// endpoint whose certificate the client will not accept reports an error and
// does not advance.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock("../../src/platform/core", () => ({ invoke }));
vi.mock("../../src/hooks/useTorState", () => ({ refreshTorState: vi.fn() }));
vi.mock("../../src/platform/legal-consent", () => ({
  betaTermsAccepted: vi.fn().mockResolvedValue(true),
  acceptBetaTerms: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/platform/opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

import { FirstRunServerStep } from "../../src/components/sync/FirstRunServerStep";
import { HOSTED_SYNC_ORIGIN } from "@myne/client-core/hosted-sync";

beforeEach(() => {
  invoke.mockReset().mockResolvedValue({ endpoint_url: null });
});

afterEach(() => cleanup());

describe("FirstRunServerStep", () => {
  it("offers both the hosted and self-hosted doors", async () => {
    render(<FirstRunServerStep onConnected={() => {}} onBack={() => {}} />);
    expect(await screen.findByTestId("first-run-server.myne-sync")).toBeTruthy();
    expect(screen.getByTestId("first-run-server.self-hosted")).toBeTruthy();
  });

  it("writes the hosted origin with no fingerprint argument when Myne Sync is chosen", async () => {
    const onConnected = vi.fn();
    render(<FirstRunServerStep onConnected={onConnected} onBack={() => {}} />);

    fireEvent.click(await screen.findByTestId("first-run-server.myne-sync"));

    // Exactly `{ endpointUrl }`. The retired `confirmedFingerprint` is not sent
    // as `null` either: the backend ignores it, and sending it keeps a removed
    // affordance looking like a live one to anything reading the IPC log.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plugin:sync|sync_set_endpoint", {
        endpointUrl: HOSTED_SYNC_ORIGIN,
      }),
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
  });

  it("reveals the self-hosted URL field behind the second door", async () => {
    render(<FirstRunServerStep onConnected={() => {}} onBack={() => {}} />);
    fireEvent.click(await screen.findByTestId("first-run-server.self-hosted"));
    expect(await screen.findByTestId("sync.endpoint-config")).toBeTruthy();
  });

  it("requires a fresh connection when repairing a configured endpoint", async () => {
    invoke.mockResolvedValue({
      endpoint_url: "https://sync.example",
      cert_pin_hex: null,
      pin_source: "platform_trust_store",
    });
    render(<FirstRunServerStep requireConnection onConnected={() => {}} onBack={() => {}} />);
    fireEvent.click(screen.getByTestId("first-run-server.self-hosted"));
    expect((await screen.findByTestId("first-run-server.continue") as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses to advance when the hosted endpoint's certificate is not accepted", async () => {
    // What replaced the fingerprint gate. `sync_set_endpoint` probes the
    // certificate before it stores the URL, so a refusal here means this device
    // would not be able to sync either, so advancing would leave the user past the
    // gate with an endpoint nothing can use.
    invoke.mockImplementation((command: string) =>
      command === "plugin:sync|sync_set_endpoint"
        ? Promise.reject({ kind: "TlsFailure" })
        : Promise.resolve({ endpoint_url: null }),
    );
    const onConnected = vi.fn();
    render(<FirstRunServerStep onConnected={onConnected} onBack={() => {}} />);
    fireEvent.click(await screen.findByTestId("first-run-server.myne-sync"));
    expect(await screen.findByTestId("first-run-server.hosted-error")).toBeTruthy();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("tells a refused certificate apart from an unreachable server", async () => {
    // The first-run door is where a self-hoster meets the hosted path, and the
    // generic copy's own remedy is "or use your own server", advice for a
    // server they cannot reach. Four other surfaces branch on the same `kind`;
    // this asserts the fifth does too, and that the two errors stay distinct.
    invoke.mockImplementation((command: string) =>
      command === "plugin:sync|sync_set_endpoint"
        ? Promise.reject({ kind: "TlsFailure" })
        : Promise.resolve({ endpoint_url: null }),
    );
    const onConnected = vi.fn();
    render(<FirstRunServerStep onConnected={onConnected} onBack={() => {}} />);
    fireEvent.click(await screen.findByTestId("first-run-server.myne-sync"));
    const err = await screen.findByTestId("first-run-server.hosted-error");
    expect(err.getAttribute("data-error-kind")).toBe("tls");
    expect(err.textContent).toBe("sync.endpoint.tlsFailure");
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("still says 'unreachable' when the server is simply not answering", async () => {
    // The counter-assertion, without which the case above is satisfied by a
    // component that always prints the TLS sentence.
    invoke.mockImplementation((command: string) =>
      command === "plugin:sync|sync_set_endpoint"
        ? Promise.reject({ kind: "Unreachable" })
        : Promise.resolve({ endpoint_url: null }),
    );
    const onConnected = vi.fn();
    render(<FirstRunServerStep onConnected={onConnected} onBack={() => {}} />);
    fireEvent.click(await screen.findByTestId("first-run-server.myne-sync"));
    const err = await screen.findByTestId("first-run-server.hosted-error");
    expect(err.getAttribute("data-error-kind")).toBe("unreachable");
    expect(err.textContent).toBe("firstRun.server.hostedError");
  });

  it("lets the user retry the hosted door after a refusal", async () => {
    let attempt = 0;
    invoke.mockImplementation((command: string) => {
      if (command === "plugin:sync|sync_set_endpoint") {
        attempt += 1;
        return attempt === 1
          ? Promise.reject({ kind: "TlsFailure" })
          : Promise.resolve({ fingerprint: null, pin_source: "platform_trust_store" });
      }
      return Promise.resolve({ endpoint_url: null });
    });
    const onConnected = vi.fn();
    render(<FirstRunServerStep onConnected={onConnected} onBack={() => {}} />);
    const door = await screen.findByTestId("first-run-server.myne-sync");
    fireEvent.click(door);
    await screen.findByTestId("first-run-server.hosted-error");
    // The button must come back enabled, or the refusal is a dead end rather
    // than an error the user can act on (a transient DNS failure, say).
    await waitFor(() => expect((door as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(door);
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
  });

  it("connects a self-hosted endpoint before returning to identity setup", async () => {
    invoke.mockImplementation((command: string) =>
      command === "plugin:sync|sync_set_endpoint"
        ? Promise.resolve({ fingerprint: null, pin_source: null })
        : Promise.resolve({ endpoint_url: "http://127.0.0.1:3000" }),
    );
    const onConnected = vi.fn();
    render(<FirstRunServerStep requireConnection onConnected={onConnected} onBack={() => {}} />);
    fireEvent.click(screen.getByTestId("first-run-server.self-hosted"));
    await screen.findByTestId("sync.endpoint-config");
    // The saved endpoint rests as Connected; explicitly re-enter a new address.
    fireEvent.change(screen.getByTestId("sync.endpoint-input"), {
      target: { value: "https://self.example" },
    });
    fireEvent.click(screen.getByTestId("sync.endpoint-connect"));
    await waitFor(() => expect((screen.getByTestId("first-run-server.continue") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("first-run-server.continue"));
    expect(onConnected).toHaveBeenCalledTimes(1);
  });
});
