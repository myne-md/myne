// @vitest-environment jsdom
//
// The honest-disclosure step on device removal (phase3-web-client task 69).
//
// `@myne/copy` has carried `REMOVE_DEVICE_CONFIRM` and
// `REMOVE_DEVICE_DISCLOSURE` since MYND-425 — single-sourced across clients,
// pinned by `tests/load-bearing-copy-shared.test.ts`, and **rendered by
// nothing**. Removal was one unconfirmed click that said nothing about what it
// does, while a test kept asserting the wording of a string no user ever saw.
//
// What the disclosure is FOR is the limit, not the effect: revoking a token
// stops the server syncing to that device, and it does not touch a device that
// already holds the vault and the password. A user who reads "Remove" as "wipe
// that laptop" is making a security decision on a false premise
// (`decisions.md` 2026-06-27, `server-protocol.md` §4).
//
// The panel is SHARED, so "identical wording on web and desktop" is true by
// construction here — there is one implementation and both clients mount it.
// These tests assert the FULL literals, which is what makes a paraphrase in
// either client a failing test rather than a review comment.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("../../src/platform/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...(a as [])),
}));
// The hook subscribes to `sync://enrollment-changed`; without this the seam
// reaches the real Tauri event module and every mount logs an unhandled
// rejection (which, in a full-suite run, is a cross-file flake — see
// `tests/setup-jsdom-cm6.ts`'s note).
vi.mock("../../src/platform/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../../src/lib/prefs", async (importOriginal) => ({
  setDeviceName: vi.fn(async () => {}),
  prefsRead: async () => ({}),
  // The REAL derivation, not a copy of it. It is what decides whether a
  // stale view can claim a deletion (myne-md/myne#613), so a stub here would
  // test the stub, and a hand-copy would be one more place for the real one
  // to drift away from.
  mutationFrom: (await importOriginal<typeof import("../../src/lib/prefs")>()).mutationFrom,
}));

const { DeviceManagementPanel } = await import("../../src/components/sync/DeviceManagementPanel");
const { useDevices } = await import("../../src/hooks/useDevices");
const { REMOVE_DEVICE_CONFIRM, REMOVE_DEVICE_DISCLOSURE } = await import("@myne/copy");

const OTHER = "bb".repeat(16);
const THIS = "aa".repeat(16);

function roster() {
  return [
    { device_id_hex: THIS, approved: true, retired: false, is_current: true },
    { device_id_hex: OTHER, approved: true, retired: false, is_current: false },
  ];
}

function Harness() {
  return <DeviceManagementPanel hook={useDevices()} plane="owner" />;
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "plugin:sync|sync_list_devices") return roster();
    if (cmd === "plugin:prefs|prefs_read") return { device_names: {} };
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

async function openConfirm() {
  render(<Harness />);
  await waitFor(() => expect(screen.getAllByTestId("sync.device-row").length).toBe(2));
  fireEvent.click(screen.getByTestId("sync.remove-device"));
  await waitFor(() => expect(screen.queryByTestId("sync.remove-confirm")).toBeTruthy());
}

describe("removing a device", () => {
  it("does not remove on the first click — it discloses first", async () => {
    await openConfirm();
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "plugin:sync|sync_remove_device"),
    ).toBe(false);
  });

  it("shows BOTH sentences, verbatim", async () => {
    await openConfirm();
    const box = screen.getByTestId("sync.remove-confirm");
    expect(box.textContent).toContain(REMOVE_DEVICE_CONFIRM);
    expect(screen.getByTestId("sync.remove-disclosure").textContent).toBe(
      REMOVE_DEVICE_DISCLOSURE,
    );
  });

  it("says what removal does NOT do — the part a user must not assume", async () => {
    // Asserted on the rendered text rather than on the constant, because the
    // failure this guards against is the panel showing only the short confirm
    // line: the wording would still be "correct" and the user would still be
    // told nothing about the limit.
    await openConfirm();
    const text = screen.getByTestId("sync.remove-disclosure").textContent ?? "";
    expect(text).toMatch(/not a remote wipe/i);
    expect(text).toMatch(/already has your vault and password/i);
  });

  it("removes only after the second, explicit confirmation", async () => {
    await openConfirm();
    fireEvent.click(screen.getByTestId("sync.remove-confirm-yes"));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter((c) => c[0] === "plugin:sync|sync_remove_device").length,
      ).toBe(1),
    );
    expect(
      invokeMock.mock.calls.find((c) => c[0] === "plugin:sync|sync_remove_device")?.[1],
    ).toEqual({ deviceIdHex: OTHER });
  });

  it("cancels without removing anything", async () => {
    await openConfirm();
    fireEvent.click(screen.getByTestId("sync.remove-confirm-cancel"));
    await waitFor(() => expect(screen.queryByTestId("sync.remove-confirm")).toBeNull());
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "plugin:sync|sync_remove_device"),
    ).toBe(false);
  });

  it("never offers removal for the device you are on", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getAllByTestId("sync.device-row").length).toBe(2));
    // One Remove button, not two: removal is never offered on the current row.
    expect(screen.getAllByTestId("sync.remove-device")).toHaveLength(1);
  });
});
