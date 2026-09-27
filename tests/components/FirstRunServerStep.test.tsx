// @vitest-environment jsdom
//
// The first-run sync-server choice (myne-md/myne#780): a hosted door and a
// self-hosted door. The hosted door must write the shared `HOSTED_SYNC_ORIGIN`
// with no fingerprint and no static-pin claim; the self-hosted door must reveal
// the same `EndpointConfig` the Settings panel mounts.

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

  it("writes the hosted origin with no fingerprint when Myne Sync is chosen", async () => {
    const onConnected = vi.fn();
    render(<FirstRunServerStep onConnected={onConnected} onBack={() => {}} />);

    fireEvent.click(await screen.findByTestId("first-run-server.myne-sync"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plugin:sync|sync_set_endpoint", {
        endpointUrl: HOSTED_SYNC_ORIGIN,
        confirmedFingerprint: null,
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
    invoke.mockResolvedValue({ endpoint_url: "https://sync.example", cert_pin_hex: "old", pin_source: "tofu" });
    render(<FirstRunServerStep requireConnection onConnected={() => {}} onBack={() => {}} />);
    fireEvent.click(screen.getByTestId("first-run-server.self-hosted"));
    expect((await screen.findByTestId("first-run-server.continue") as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens a fingerprint gate for the hosted server instead of flattening a rotated pin", async () => {
    const current = "ab".repeat(32);
    invoke.mockImplementation((command: string, args?: { confirmedFingerprint?: string }) => {
      if (command === "plugin:sync|sync_set_endpoint") {
        return args?.confirmedFingerprint === current
          ? Promise.resolve({ fingerprint: current, pin_source: "tofu" })
          : Promise.reject({ kind: "CertificateChanged" });
      }
      return Promise.resolve({ endpoint_url: "https://sync.myne.md" });
    });
    const onConnected = vi.fn();
    render(<FirstRunServerStep requireConnection onConnected={onConnected} onBack={() => {}} />);
    fireEvent.click(screen.getByTestId("first-run-server.myne-sync"));
    expect(await screen.findByTestId("first-run-server.pin-error")).toBeTruthy();
    expect(onConnected).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("first-run-server.expected-fingerprint-input"), {
      target: { value: current },
    });
    fireEvent.click(screen.getByTestId("first-run-server.fingerprint-confirm"));
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith("plugin:sync|sync_set_endpoint", {
      endpointUrl: HOSTED_SYNC_ORIGIN,
      confirmedFingerprint: current,
    });
  });

  it("does not proceed when the expected hosted fingerprint is rejected", async () => {
    invoke.mockImplementation((command: string, args?: { confirmedFingerprint?: string }) =>
      command === "plugin:sync|sync_set_endpoint"
        ? Promise.reject({ kind: args?.confirmedFingerprint ? "FingerprintMismatch" : "CertificateChanged" })
        : Promise.resolve({ endpoint_url: HOSTED_SYNC_ORIGIN }),
    );
    const onConnected = vi.fn();
    render(<FirstRunServerStep requireConnection onConnected={onConnected} onBack={() => {}} />);
    fireEvent.click(screen.getByTestId("first-run-server.myne-sync"));
    await screen.findByTestId("first-run-server.fingerprint-gate");
    fireEvent.change(screen.getByTestId("first-run-server.expected-fingerprint-input"), {
      target: { value: "ab".repeat(32) },
    });
    fireEvent.click(screen.getByTestId("first-run-server.fingerprint-confirm"));
    await waitFor(() => expect(screen.getByTestId("first-run-server.pin-error").textContent).toBe("sync.endpoint.confirmFingerprintMismatch"));
    expect(onConnected).not.toHaveBeenCalled();
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
