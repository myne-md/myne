// @vitest-environment jsdom
//
// The sync endpoint control's invite-code field (myne-md/myne#815).
//
// The field is for admission only, so it is rendered while the endpoint is not
// yet connected and hidden once it is. The stored code stays in state and is
// still sent on a reconnect; these cases pin both halves of that.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../src/platform/core", () => ({ invoke }));
vi.mock("../../src/hooks/useTorState", () => ({ refreshTorState: vi.fn() }));

import { EndpointConfig } from "../../src/components/sync/EndpointConfig";

function endpoint(overrides: Record<string, unknown>) {
  return { endpoint_url: null, pin_source: null, invite_code: null, ...overrides };
}

beforeEach(() => {
  invoke.mockReset();
});
afterEach(cleanup);

describe("EndpointConfig invite field", () => {
  it("hides the field once the endpoint is connected", async () => {
    invoke.mockResolvedValue(
      endpoint({ endpoint_url: "https://sync.myne.md", invite_code: "seed-code" }),
    );
    render(<EndpointConfig />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("sync.endpoint-connect") as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect(screen.queryByTestId("sync.endpoint-invite-input")).toBeNull();
  });

  it("shows the field when no endpoint is connected", async () => {
    invoke.mockResolvedValue(endpoint({}));
    render(<EndpointConfig />);
    expect(await screen.findByTestId("sync.endpoint-invite-input")).toBeTruthy();
  });

  it("prefills the stored code while unconnected", async () => {
    invoke.mockResolvedValue(endpoint({ invite_code: "stored-code" }));
    render(<EndpointConfig />);
    const field = (await screen.findByTestId(
      "sync.endpoint-invite-input",
    )) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("stored-code"));
  });
});
