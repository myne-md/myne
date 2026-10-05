// @vitest-environment jsdom
//
// The sync endpoint control's invite-code field (myne-md/myne#815, corrected by
// myne-md/myne#822).
//
// The field is for admission only, so it is rendered while the endpoint is not
// yet connected and hidden once it is. These cases pin the show/hide/prefill
// behaviour ONLY. They do NOT pin a "still sent on a reconnect" path, because
// there is none: every reconnect goes through an address change (or the locked
// door's explicit "Change invite code" reveal), and both send whatever is in the
// field. The previous header claimed to pin that half; it did not, and the claim
// was false (myne-md/myne#822).

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

  it("re-reveals the invite field on the locked hosted door (myne-md/myne#822)", async () => {
    // On this door the address is read-only, so editing it can never re-reveal
    // the field; the explicit control is the only escape from a wrong/rotated
    // code. Without it a connected user cannot correct the code at all.
    invoke.mockResolvedValue(
      endpoint({
        endpoint_url: "https://sync.myne.md",
        invite_code: "seed-code",
      }),
    );
    const { getByTestId, queryByTestId } = render(
      <EndpointConfig
        initialUrl="https://sync.myne.md"
        lockedUrl
      />,
    );
    // Connected: field hidden, no address editing possible.
    await waitFor(() =>
      expect(
        (getByTestId("sync.endpoint-connect") as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect(queryByTestId("sync.endpoint-invite-input")).toBeNull();
    // The escape hatch reveals it AND re-enables Connect.
    (getByTestId("sync.endpoint-change-invite") as HTMLButtonElement).click();
    await waitFor(() =>
      expect(getByTestId("sync.endpoint-invite-input")).toBeTruthy(),
    );
    expect(
      (getByTestId("sync.endpoint-connect") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
