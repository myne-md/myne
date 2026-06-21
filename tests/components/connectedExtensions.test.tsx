// @vitest-environment jsdom
//
// Component tests for `src/components/settings/ConnectedExtensions.tsx`
// (ext-foundation-handoff task 7, MYND-443; browser-label + "connected when"
// added 2026-06-21). Covers: the paired list renders a row per extension showing
// the BROWSER (derived from the id) + a "connected when" line + a Revoke action
// (the raw id is not shown — it's a tooltip + the discriminator attribute);
// clicking Revoke invokes the `pairing_revoke` wrapper and refreshes the list;
// and the empty state. The IPC-boundary wrappers (`listPairedExtensions` /
// `revokePairedExtension`) are mocked at their lib boundary — the Button + the
// BrowserIcon render for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const listPairedExtensions = vi.fn();
const revokePairedExtension = vi.fn();

vi.mock("../../src/lib/clipper-pairing", () => ({
  listPairedExtensions: (...a: unknown[]) => listPairedExtensions(...a),
  revokePairedExtension: (...a: unknown[]) => revokePairedExtension(...a),
}));

import { ConnectedExtensions } from "../../src/components/settings/ConnectedExtensions";
import {
  CONNECTED_EXTENSIONS_EMPTY,
  CONNECTED_EXTENSIONS_TITLE,
} from "../../src/lib/load-bearing-copy";

// A Firefox pairing (gecko id) + a Chromium one (32-char a–p id) so the derived
// browser labels are distinct and testable.
const FIREFOX_ID = "clipper@myne.md";
const CHROME_ID = "abcdefghijklmnopabcdefghijklmnop";
const NOW = Math.floor(Date.now() / 1000);

beforeEach(() => {
  listPairedExtensions.mockReset();
  revokePairedExtension.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("ConnectedExtensions — list + revoke", () => {
  it("renders a row per paired extension: browser + connected-when + Revoke", async () => {
    listPairedExtensions.mockResolvedValue([
      { extensionId: FIREFOX_ID, pairedAt: NOW },
      { extensionId: CHROME_ID, pairedAt: null },
    ]);
    render(<ConnectedExtensions />);

    expect(screen.getByText(CONNECTED_EXTENSIONS_TITLE)).toBeTruthy();

    await waitFor(() => {
      expect(
        screen.getAllByTestId("settings.connected-extension-row"),
      ).toHaveLength(2);
    });
    // The BROWSER is shown (not the raw id).
    expect(screen.getByText("Firefox")).toBeTruthy();
    expect(screen.getByText("Chrome / Edge")).toBeTruthy();
    // Each row shows a "connected when" line: the Chromium row has no timestamp
    // → bare "Connected"; the Firefox row was paired `NOW` → "Connected just now".
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Connected just now")).toBeTruthy();
    // The raw id is NOT rendered as visible text — only as the discriminator
    // attribute (+ a row tooltip).
    expect(screen.queryByText(CHROME_ID)).toBeNull();

    const revokeButtons = screen.getAllByTestId("settings.revoke-extension");
    expect(revokeButtons).toHaveLength(2);
    expect(revokeButtons.map((b) => b.getAttribute("data-extension-id"))).toEqual(
      [FIREFOX_ID, CHROME_ID],
    );
  });

  it("revokes the chosen extension and refreshes the list (it disappears)", async () => {
    listPairedExtensions
      .mockResolvedValueOnce([
        { extensionId: FIREFOX_ID, pairedAt: NOW },
        { extensionId: CHROME_ID, pairedAt: null },
      ])
      .mockResolvedValueOnce([{ extensionId: CHROME_ID, pairedAt: null }]);
    render(<ConnectedExtensions />);

    await waitFor(() =>
      expect(
        screen.getAllByTestId("settings.connected-extension-row"),
      ).toHaveLength(2),
    );

    const firefoxRevoke = screen
      .getAllByTestId("settings.revoke-extension")
      .find((b) => b.getAttribute("data-extension-id") === FIREFOX_ID);
    expect(firefoxRevoke).toBeTruthy();

    await act(async () => {
      fireEvent.click(firefoxRevoke!);
    });

    expect(revokePairedExtension).toHaveBeenCalledWith(FIREFOX_ID);
    expect(listPairedExtensions).toHaveBeenCalledTimes(2);

    // The revoked Firefox pairing is gone; the Chromium one remains.
    await waitFor(() =>
      expect(
        screen.getAllByTestId("settings.connected-extension-row"),
      ).toHaveLength(1),
    );
    expect(screen.queryByText("Firefox")).toBeNull();
    expect(screen.getByText("Chrome / Edge")).toBeTruthy();
  });

  it("renders the empty state when no extension is paired", async () => {
    listPairedExtensions.mockResolvedValue([]);
    render(<ConnectedExtensions />);

    await waitFor(() =>
      expect(
        screen.getByTestId("settings.connected-extensions-empty").textContent,
      ).toBe(CONNECTED_EXTENSIONS_EMPTY),
    );
    expect(
      screen.queryByTestId("settings.connected-extension-row"),
    ).toBeNull();
    expect(screen.queryByTestId("settings.revoke-extension")).toBeNull();
  });

  it("treats an IPC read failure as no connected extensions (never throws)", async () => {
    listPairedExtensions.mockRejectedValue(new Error("not a tauri context"));
    render(<ConnectedExtensions />);

    await waitFor(() =>
      expect(
        screen.getByTestId("settings.connected-extensions-empty"),
      ).toBeTruthy(),
    );
  });
});
