// @vitest-environment jsdom
//
// The first-run sync-server choice (myne-md/myne#780, invite code myne-md/myne#800):
// a hosted door and a self-hosted door.
//
// The hosted door seeds the SAME `EndpointConfig` the Settings panel mounts, with
// the origin locked and the address read-only, so its one-tap connection carries
// the invite-code field a gated server needs. A bare `sync_set_endpoint` on the
// hosted button (the pre-fix shape) sent no code and had nowhere to enter one, so
// the hosted server — which IS the gated one — could not be reached at all. The
// self-hosted door reveals the same control unlocked.
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

  it("opens the hosted door with the origin locked and the invite field available", async () => {
    render(<FirstRunServerStep onConnected={() => {}} onBack={() => {}} />);

    fireEvent.click(await screen.findByTestId("first-run-server.myne-sync"));

    // The same EndpointConfig the Settings panel mounts, seeded with the hosted
    // origin and locked, so the user may enter only the invite code.
    const config = await screen.findByTestId("sync.endpoint-config");
    expect(config).toBeTruthy();
    const url = screen.getByTestId("sync.endpoint-input") as HTMLInputElement;
    expect(url.value).toBe(HOSTED_SYNC_ORIGIN);
    expect(url.readOnly).toBe(true);
    expect(screen.getByTestId("sync.endpoint-invite-input")).toBeTruthy();
  });

  it("connects the hosted origin and carries the typed invite code", async () => {
    invoke.mockImplementation((command: string) =>
      command === "plugin:sync|sync_set_endpoint"
        ? Promise.resolve({ fingerprint: null, pin_source: "platform_trust_store" })
        : Promise.resolve({ endpoint_url: null }),
    );
    const onConnected = vi.fn();
    render(<FirstRunServerStep onConnected={onConnected} onBack={() => {}} />);

    fireEvent.click(await screen.findByTestId("first-run-server.myne-sync"));
    fireEvent.change(await screen.findByTestId("sync.endpoint-invite-input"), {
      target: { value: "beta-code-0000000000000000000000000001" },
    });
    fireEvent.click(screen.getByTestId("sync.endpoint-connect"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plugin:sync|sync_set_endpoint", {
        endpointUrl: HOSTED_SYNC_ORIGIN,
        inviteCode: "beta-code-0000000000000000000000000001",
      }),
    );
    await waitFor(() =>
      expect((screen.getByTestId("first-run-server.continue") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("reveals the self-hosted URL field behind the second door, unlocked", async () => {
    render(<FirstRunServerStep onConnected={() => {}} onBack={() => {}} />);
    fireEvent.click(await screen.findByTestId("first-run-server.self-hosted"));
    expect(await screen.findByTestId("sync.endpoint-config")).toBeTruthy();
    expect((screen.getByTestId("sync.endpoint-input") as HTMLInputElement).readOnly).toBe(false);
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
    fireEvent.click(await screen.findByTestId("sync.endpoint-connect"));
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
    fireEvent.click(await screen.findByTestId("first-run-server.myne-sync"));
    fireEvent.click(await screen.findByTestId("sync.endpoint-connect"));
    const msg = await screen.findByTestId("sync.endpoint-msg");
    expect(msg.textContent).toBe("sync.endpoint.unreachable");
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
