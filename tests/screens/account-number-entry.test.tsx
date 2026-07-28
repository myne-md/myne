// @vitest-environment jsdom
//
// The web first-run identity step (phase3-web-client task 30).
//
// The two properties worth a test are both about WHERE the answer comes from:
// the rejection must be local and immediate (no network, no server round-trip),
// and the validity verdict must come from the Rust parser rather than from a
// TypeScript re-implementation of a frozen Damm-32 table. Both are asserted on
// the `invoke` call itself, because from the component's side that is the only
// observable difference between "checked locally" and "asked a server".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import { AccountNumberEntry } from "../../src/screens/AccountNumberEntry";

/** A syntactically complete display-form value (27 chars). Validity is the
 *  backend's verdict, so the string only has to be the right SHAPE here. */
const DISPLAY_FORM = "MY-4K7P-9QRS-2TVW-XYZ0-1234";

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  cleanup();
});

function type(value: string): void {
  fireEvent.change(screen.getByTestId("account-entry.input"), { target: { value } });
}

describe("account-number entry", () => {
  it("masks input into the display form as the user types", () => {
    render(<AccountNumberEntry onValid={() => {}} />);
    type("my4k7p9qrs");
    // Uppercased, grouped, prefix recognised — the mask is presentation-only and
    // idempotent, so what the user sees is what gets submitted.
    expect((screen.getByTestId("account-entry.input") as HTMLInputElement).value).toBe(
      "MY-4K7P-9QRS",
    );
  });

  it("cannot submit an incomplete number, and asks nothing while it is incomplete", async () => {
    render(<AccountNumberEntry onValid={() => {}} />);
    type("MY-4K7P");
    expect((screen.getByTestId("account-entry.submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("account-entry.submit"));
    // Not merely "no error shown": nothing was ASKED. A per-keystroke probe
    // would be a validity oracle for anyone watching the wire.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects locally — one command, no network, and a non-distinguishing message", async () => {
    invokeMock.mockResolvedValue(false);
    render(<AccountNumberEntry onValid={() => {}} />);
    type(DISPLAY_FORM);
    fireEvent.click(screen.getByTestId("account-entry.submit"));

    const banner = await screen.findByTestId("account-entry.error");
    expect(banner.textContent).toBe("That account number is not valid. Check it and try again.");

    // The verdict came from the Rust parser, through the ONE local command —
    // not from a TS re-implementation of the Damm-32 table, and not from a
    // server. `account_number_check` is dispatched in-process on desktop and
    // in the Worker on web; either way nothing leaves the client.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("plugin:vault-unlock|account_number_check", {
      accountNumber: DISPLAY_FORM,
    });
  });

  it("hands the raw value onward when the backend accepts it", async () => {
    invokeMock.mockResolvedValue(true);
    const onValid = vi.fn();
    render(<AccountNumberEntry onValid={onValid} />);
    type(DISPLAY_FORM);
    fireEvent.click(screen.getByTestId("account-entry.submit"));

    await waitFor(() => expect(onValid).toHaveBeenCalledWith(DISPLAY_FORM));
    expect(screen.queryByTestId("account-entry.error")).toBeNull();
  });

  it("a failed CHECK is not reported as a wrong account number", async () => {
    // A dead Worker or a refused command means the check did not run. Telling
    // the user their number is wrong would send them to re-read a number that is
    // fine — the two failures have opposite recoveries.
    invokeMock.mockRejectedValue({ kind: "NotPortedToWeb" });
    render(<AccountNumberEntry onValid={() => {}} />);
    type(DISPLAY_FORM);
    fireEvent.click(screen.getByTestId("account-entry.submit"));

    const banner = await screen.findByTestId("account-entry.error");
    expect(banner.textContent).toBe("Could not check that account number. Try again.");
  });

  it("clears the message when the field changes", async () => {
    invokeMock.mockResolvedValue(false);
    render(<AccountNumberEntry onValid={() => {}} />);
    type(DISPLAY_FORM);
    fireEvent.click(screen.getByTestId("account-entry.submit"));
    await screen.findByTestId("account-entry.error");

    type(DISPLAY_FORM.slice(0, 20));
    expect(screen.queryByTestId("account-entry.error")).toBeNull();
  });
});
