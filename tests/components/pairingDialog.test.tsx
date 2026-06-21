// @vitest-environment jsdom
//
// Component tests for `src/components/PairingDialog.tsx` (ext-foundation-handoff
// task 4, TB10). The pairing dialog is the ONLY human-in-the-loop check in the
// whole token-issuance chain — the user compares the numeric challenge against
// the code the extension shows, then Accept mints a scoped, revocable token or
// Reject clears the session. A wrong-render here would silently defeat the
// out-of-band verification, so it is covered directly. (The cross-process
// browser↔host leg is the deferred Linux-CI E2E layer; see
// `docs/dev/clipper-testing.md` + `docs/decisions.md` 2026-06-21.)
//
// The IPC-boundary wrappers are mocked at their lib boundary; the dialog's
// poll → render → Accept/Reject state machine runs for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

interface Pending {
  challenge: string;
  request_id?: string | null;
}

const pairingPending = vi.fn();
const pairingAccept = vi.fn();
const pairingReject = vi.fn();
const pairingDispatchComplete = vi.fn();

vi.mock("../../src/lib/clipper-pairing", () => ({
  pairingPending: (...a: unknown[]) => pairingPending(...a),
  pairingAccept: (...a: unknown[]) => pairingAccept(...a),
  pairingReject: (...a: unknown[]) => pairingReject(...a),
  pairingDispatchComplete: (...a: unknown[]) => pairingDispatchComplete(...a),
}));

import {
  PairingDialog,
  PAIRING_TITLE,
  PAIRING_REJECTED_COPY,
} from "../../src/components/PairingDialog";

// A mutable "current pending session" the poll mock returns; flipped to null by
// the Accept/Reject mocks to model the host clearing the session.
let pendingValue: Pending | null = null;

beforeEach(() => {
  pendingValue = null;
  pairingPending.mockReset().mockImplementation(() => Promise.resolve(pendingValue));
  pairingAccept.mockReset().mockImplementation(() => {
    pendingValue = null; // the session resolves on the host once minted
    return Promise.resolve("MINTED-TOKEN");
  });
  pairingReject.mockReset().mockImplementation(() => {
    pendingValue = null;
    return Promise.resolve(undefined);
  });
  pairingDispatchComplete.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("PairingDialog — challenge / accept / reject", () => {
  it("renders nothing when no pairing session is pending", async () => {
    render(<PairingDialog />);
    // Let the mount poll resolve (idle).
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("pairing.dialog")).toBeNull();
  });

  it("renders the challenge VERBATIM when a session is pending", async () => {
    // A challenge with a leading zero — must render byte-for-byte, not as a
    // number (a coerced/format-shifted code would break out-of-band compare).
    pendingValue = { challenge: "048213", request_id: "req-1" };
    render(<PairingDialog />);

    await waitFor(() =>
      expect(screen.getByTestId("pairing.dialog")).toBeTruthy(),
    );
    expect(screen.getByText(PAIRING_TITLE)).toBeTruthy();
    expect(screen.getByTestId("pairing.challenge").textContent).toBe("048213");
  });

  it("Accept mints the token and delivers it to the relay, then clears", async () => {
    pendingValue = { challenge: "111222", request_id: "req-42" };
    render(<PairingDialog />);
    await waitFor(() =>
      expect(screen.getByTestId("pairing.accept")).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("pairing.accept"));
    });

    expect(pairingAccept).toHaveBeenCalledTimes(1);
    // The minted token is handed to the blocked relay thread for this request.
    expect(pairingDispatchComplete).toHaveBeenCalledWith(
      "req-42",
      "accepted",
      "MINTED-TOKEN",
    );
    // Session resolved → the dialog leaves the screen.
    await waitFor(() => expect(screen.queryByTestId("pairing.dialog")).toBeNull());
  });

  it("Reject declines the session and shows the rejected acknowledgement", async () => {
    pendingValue = { challenge: "333444", request_id: "req-7" };
    render(<PairingDialog />);
    await waitFor(() =>
      expect(screen.getByTestId("pairing.reject")).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("pairing.reject"));
    });

    expect(pairingReject).toHaveBeenCalledTimes(1);
    // The relay is told the user declined → it replies an honest error, never a
    // fake pairing.
    expect(pairingDispatchComplete).toHaveBeenCalledWith("req-7", "rejected");
    // No token is ever minted on the reject path.
    expect(pairingAccept).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("pairing.rejected").textContent).toBe(
        PAIRING_REJECTED_COPY,
      ),
    );
  });

  it("a rapid double-click on Accept mints EXACTLY once (no double-mint)", async () => {
    pendingValue = { challenge: "555666", request_id: "req-9" };
    render(<PairingDialog />);
    await waitFor(() =>
      expect(screen.getByTestId("pairing.accept")).toBeTruthy(),
    );

    const accept = screen.getByTestId("pairing.accept");
    await act(async () => {
      // Two synchronous clicks before React can re-render/disable the button —
      // the re-entry guard must collapse them to a single mint.
      fireEvent.click(accept);
      fireEvent.click(accept);
    });

    expect(pairingAccept).toHaveBeenCalledTimes(1);
    expect(pairingDispatchComplete).toHaveBeenCalledTimes(1);
  });
});
