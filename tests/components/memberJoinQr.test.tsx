// @vitest-environment jsdom
//
// Component tests for the MEMBER variant of `DeviceJoinQr` (myne-md/myne).
//
// The variant exists because the owner's QR and a member's answer different
// questions: the owner's takes the account number pasted in and leads to
// `{account# + password}`, while a member holds neither the number nor the
// password and their other device proves the 24-word phrase. What this file pins
// is that the two variants are actually different code paths — the member one
// calls the member command, renders no account field, mints its code with no user
// input, and maps a refusal to the member's OWN sentence rather than the account's.
//
// jsdom needs `URL.createObjectURL` (jsdom does not implement it), the same stub
// `tests/notes/noteImageCard.test.ts` uses.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { DeviceJoinQr } from "../../src/components/sync/DeviceJoinQr";
import i18n from "../../src/i18n";

const SVG_STUB = "<svg xmlns='http://www.w3.org/2000/svg'></svg>";

beforeEach(() => {
  invokeMock.mockReset();
  // jsdom has no object-URL support; the component mints one per rendered SVG.
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(() => "blob:member-join-qr"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

describe("DeviceJoinQr — the member variant", () => {
  it("mints its code with no input, and never asks for an account number", async () => {
    invokeMock.mockResolvedValue({ svg: SVG_STUB, ttl_secs: 180 });

    render(<DeviceJoinQr variant="member" />);

    await waitFor(() =>
      expect(screen.queryByTestId("sync.member-join-qr.image")).toBeTruthy(),
    );
    // The member command, not the account one, and called with no arguments: the
    // vault is resolved from the active session backend-side.
    expect(invokeMock.mock.calls.map((c) => c[0])).toContain(
      "plugin:sync|sync_member_join_qr",
    );
    expect(invokeMock.mock.calls.map((c) => c[0])).not.toContain(
      "plugin:sync|sync_device_join_qr",
    );
    // No account-number field anywhere: a member has no account number to give.
    expect(screen.queryByTestId("sync.device-join-qr.account-input")).toBeNull();
    // The three steps the code shortcuts are spelled out, because this dialog is
    // the only place the member's own-device path is explained.
    expect(
      screen.getByTestId("sync.member-join-qr.steps").querySelectorAll("li"),
    ).toHaveLength(3);
  });

  it("maps a refusal to the member's own sentence", async () => {
    // `NotAMemberVault` has no account-plane equivalent, which is why the two
    // variants do not share an error mapper.
    invokeMock.mockRejectedValue({ kind: "NotAMemberVault" });

    render(<DeviceJoinQr variant="member" />);

    const error = await screen.findByTestId("sync.member-join-qr.error");
    // Resolved through the REAL catalog, so a renamed key fails here rather than
    // silently rendering the key path.
    expect(error.textContent).toBe(i18n.t("sync.memberJoinQr.notAMember"));
    expect(error.textContent).not.toBe(i18n.t("sync.deviceJoinQr.error"));
    // Nothing was minted, and no QR is shown.
    expect(screen.queryByTestId("sync.member-join-qr.image")).toBeNull();
  });

  it("the account variant is untouched: it needs the paste and stays idle until then", async () => {
    // The positive control for the two tests above. The account variant renders
    // its input and mints nothing on mount — so the member variant's auto-mint is
    // a property of the member variant, not of the component.
    invokeMock.mockResolvedValue({ svg: SVG_STUB, ttl_secs: 180 });

    render(<DeviceJoinQr variant="account" />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("sync.device-join-qr.account-input"),
      ).toBeTruthy(),
    );
    expect(screen.queryByTestId("sync.member-join-qr.steps")).toBeNull();
    expect(screen.queryByTestId("sync.device-join-qr.image")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
