// @vitest-environment jsdom
//
// myne#290 — a pairing whose durability could not be confirmed must SAY so.
//
// `pairing_accept` consumed the pending session and minted the token before the
// `vault.prefs` write could fail. The dialog's catch then set `idle` on the
// stated assumption that "the session is left intact so a retry is
// non-destructive" — which was true for a CSPRNG failure and false for this one.
// The re-poll found nothing, the card vanished, and the user read that as a
// successful Connect while holding a paired-but-unusable extension that the next
// lock or restart would erase.
//
// The host rolls the accept back now, so the session really is intact. What this
// pins is the other half: the dialog must not treat "could not save" as "done".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { PairingDialog } from "../../src/components/PairingDialog";

const PENDING = {
  extension_id: "clipper@myne.md",
  challenge: 421337,
  request_id: "req-1",
};

/** Answer `pairing_pending` with a live session; `pairing_accept` per `accept`. */
function mount(accept: () => Promise<unknown>) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "plugin:clipper-pairing|pairing_pending") return PENDING;
    if (cmd === "plugin:clipper-pairing|pairing_accept") return accept();
    return undefined;
  });
  return render(<PairingDialog />);
}

beforeEach(() => invokeMock.mockReset());
afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

describe("the pairing dialog on a durability failure", () => {
  it("tells the user the connection was not saved", async () => {
    mount(() => Promise.reject({ kind: "PersistFailed" }));
    const accept = await screen.findByTestId("pairing.accept");

    await act(async () => {
      fireEvent.click(accept);
    });

    await waitFor(() =>
      expect(screen.queryByTestId("pairing.persist-failed")).toBeTruthy(),
    );
    expect(screen.getByTestId("pairing.persist-failed").textContent).toBeTruthy();
  });

  it("does not silently return to idle — the card must not just vanish", async () => {
    mount(() => Promise.reject({ kind: "PersistFailed" }));
    const accept = await screen.findByTestId("pairing.accept");
    await act(async () => {
      fireEvent.click(accept);
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("pairing.dialog").getAttribute("data-phase"),
      ).toBe("persist-failed"),
    );
  });

  it("still treats a mint failure as the transient case it is", async () => {
    // CSPRNG failure genuinely leaves the session intact and needs no message —
    // the re-poll puts the card back. Keeping the two distinguishable is the
    // point; collapsing them would have hidden this bug just as well.
    mount(() => Promise.reject({ kind: "CsprngUnavailable" }));
    const accept = await screen.findByTestId("pairing.accept");
    await act(async () => {
      fireEvent.click(accept);
    });
    await waitFor(() =>
      expect(screen.queryByTestId("pairing.persist-failed")).toBeNull(),
    );
  });
});
