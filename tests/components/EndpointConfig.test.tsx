// @vitest-environment jsdom
//
// The sync endpoint control's invite-code field (myne-md/myne#815, corrected by
// myne-md/myne#822).
//
// The field is for admission only, so it is rendered while the endpoint is not
// yet connected and hidden once it is. These cases pin the show/hide/prefill
// behaviour ONLY, plus the one path back to the field: editing the address
// clears the stored code and re-reveals it. They do NOT pin a "still sent on a
// reconnect" path, because there is none: a reconnect goes through an address
// change, and that re-send carries whatever is in the field. The previous header
// claimed to pin that half; it did not, and the claim was false
// (myne-md/myne#822).

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      endpoint({ endpoint_url: "https://sync.example", invite_code: "seed-code" }),
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

  it("re-reveals the field and clears the code when the address is edited", async () => {
    // The one path back to a connected endpoint's code. The address is the only
    // editable thing, so changing it is what re-opens the field, and the old
    // code must not survive to be sent to the new server.
    invoke.mockResolvedValue(
      endpoint({ endpoint_url: "https://sync.example", invite_code: "seed-code" }),
    );
    render(<EndpointConfig />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("sync.endpoint-connect") as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect(screen.queryByTestId("sync.endpoint-invite-input")).toBeNull();

    fireEvent.change(screen.getByTestId("sync.endpoint-input"), {
      target: { value: "https://other.example" },
    });

    const field = (await screen.findByTestId(
      "sync.endpoint-invite-input",
    )) as HTMLInputElement;
    expect(field.value).toBe("");
    expect(
      (screen.getByTestId("sync.endpoint-connect") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
