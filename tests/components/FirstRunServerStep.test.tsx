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
});
