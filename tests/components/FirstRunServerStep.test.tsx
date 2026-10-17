// @vitest-environment jsdom
//
// The first-run sync-server step (myne-md/myne#768).
//
// The step is one door now: the free-text `EndpointConfig` the Settings panel
// mounts, with the invite-code field a gated server needs. It used to offer a
// hosted "Myne Sync" door beside this one, and that door is gone with the
// decision that Myne operates no sync service it offers. These cases pin the
// single-door shape, and that Continue stays gated on a real connection.
//
// The certificate gate this file used to test, a "the pin changed" form the user
// answered by pasting the old fingerprint, was removed with pinning
// (`decisions/sync/0620`); the refusal now surfaces through `EndpointConfig`'s own
// message line, tested in `EndpointConfig`'s spec.

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

beforeEach(() => {
  invoke.mockReset().mockResolvedValue({ endpoint_url: null });
});

afterEach(() => cleanup());

describe("FirstRunServerStep", () => {
  it("goes straight to the URL form, with no hosted door", async () => {
    render(<FirstRunServerStep onConnected={() => {}} onBack={() => {}} />);
    const config = await screen.findByTestId("sync.endpoint-config");
    expect(config).toBeTruthy();
    expect((screen.getByTestId("sync.endpoint-input") as HTMLInputElement).readOnly).toBe(false);
    expect(screen.queryByTestId("first-run-server.myne-sync")).toBeNull();
  });

  it("connects the typed endpoint and carries the invite code", async () => {
    invoke.mockImplementation((command: string) =>
      command === "plugin:sync|sync_set_endpoint"
        ? Promise.resolve({ fingerprint: null, pin_source: "platform_trust_store" })
        : Promise.resolve({ endpoint_url: null }),
    );
    const onConnected = vi.fn();
    render(<FirstRunServerStep onConnected={onConnected} onBack={() => {}} />);

    await screen.findByTestId("sync.endpoint-config");
    fireEvent.change(screen.getByTestId("sync.endpoint-input"), {
      target: { value: "https://self.example" },
    });
    fireEvent.change(screen.getByTestId("sync.endpoint-invite-input"), {
      target: { value: "server-code-000000000000000000000001" },
    });
    fireEvent.click(screen.getByTestId("sync.endpoint-connect"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plugin:sync|sync_set_endpoint", {
        endpointUrl: "https://self.example",
        inviteCode: "server-code-000000000000000000000001",
      }),
    );
    await waitFor(() =>
      expect((screen.getByTestId("first-run-server.continue") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("requires a fresh connection when repairing a configured endpoint", async () => {
    invoke.mockResolvedValue({
      endpoint_url: "https://sync.example",
      cert_pin_hex: null,
      pin_source: "platform_trust_store",
    });
    render(<FirstRunServerStep requireConnection onConnected={() => {}} onBack={() => {}} />);
    expect((await screen.findByTestId("first-run-server.continue") as HTMLButtonElement).disabled).toBe(true);
  });

  it("leads back out when Back is pressed", async () => {
    const onBack = vi.fn();
    render(<FirstRunServerStep onConnected={() => {}} onBack={onBack} />);
    fireEvent.click(await screen.findByTestId("first-run-server.back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("refuses to advance when the endpoint's certificate is not accepted", async () => {
    // `sync_set_endpoint` probes the certificate before it stores the URL, so a
    // refusal here means this device would not be able to sync either, so
    // advancing would leave the user past the gate with an endpoint nothing can
    // use.
    invoke.mockImplementation((command: string) =>
      command === "plugin:sync|sync_set_endpoint"
        ? Promise.reject({ kind: "TlsFailure" })
        : Promise.resolve({ endpoint_url: null }),
    );
    const onConnected = vi.fn();
    render(<FirstRunServerStep onConnected={onConnected} onBack={() => {}} />);
    fireEvent.change(await screen.findByTestId("sync.endpoint-input"), {
      target: { value: "https://self.example" },
    });
    fireEvent.click(screen.getByTestId("sync.endpoint-connect"));
    const msg = await screen.findByTestId("sync.endpoint-msg");
    expect(msg.textContent).toBe("sync.endpoint.tlsFailure");
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
    fireEvent.change(await screen.findByTestId("sync.endpoint-input"), {
      target: { value: "https://self.example" },
    });
    fireEvent.click(screen.getByTestId("sync.endpoint-connect"));
    const msg = await screen.findByTestId("sync.endpoint-msg");
    expect(msg.textContent).toBe("sync.endpoint.unreachable");
  });

  it("connects an endpoint before returning to identity setup", async () => {
    invoke.mockImplementation((command: string) =>
      command === "plugin:sync|sync_set_endpoint"
        ? Promise.resolve({ fingerprint: null, pin_source: null })
        : Promise.resolve({ endpoint_url: "http://127.0.0.1:3000" }),
    );
    const onConnected = vi.fn();
    render(<FirstRunServerStep requireConnection onConnected={onConnected} onBack={() => {}} />);
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
