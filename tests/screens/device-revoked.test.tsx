// @vitest-environment jsdom
//
// This browser was removed from the account (phase3-web-client task 94).
//
// The two properties worth testing are both about honesty under pressure:
//
//   * **The erase happens without asking.** Not a UX shortcut — the user already
//     confirmed it, on the other device, when they removed this one. A confirm
//     here would be a second chance to keep a copy the account owner has
//     explicitly cut off, on a machine that may not be theirs.
//   * **The copy never implies a remote wipe.** `REMOVE_DEVICE_DISCLOSURE`
//     promises the person doing the removing that removal "does not lock a
//     device that already has your vault and password". This screen is read by
//     the person it happened TO. If the two disagree, a user who reads both
//     concludes one of them is lying — so the erase is stated as something this
//     client did to itself, and the unsynced loss is named rather than left to
//     be discovered.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DeviceRevoked } from "../../src/screens/DeviceRevoked";
import {
  DEVICE_REVOKED_DISCLOSURE,
  REMOVE_DEVICE_DISCLOSURE,
} from "../../src/lib/load-bearing-copy";

afterEach(cleanup);

describe("device revoked", () => {
  it("erases without asking", async () => {
    const onEraseLocalCopy = vi.fn(async () => {});
    render(<DeviceRevoked onEraseLocalCopy={onEraseLocalCopy} onDismiss={() => {}} />);
    await waitFor(() => expect(onEraseLocalCopy).toHaveBeenCalledTimes(1));
    // No confirm gate, no typed-DELETE box: the account owner already decided.
    expect(screen.queryByTestId("device-revoked.confirm")).toBeNull();
  });

  it("erases exactly once, not once per render", async () => {
    // The effect runs on mount with a stable dependency. A version that
    // re-fired would re-enter an erase on every parent re-render — harmless on
    // the happy path and a retry storm on a failing one.
    const onEraseLocalCopy = vi.fn(async () => {});
    const { rerender } = render(
      <DeviceRevoked onEraseLocalCopy={onEraseLocalCopy} onDismiss={() => {}} />,
    );
    await waitFor(() => expect(onEraseLocalCopy).toHaveBeenCalledTimes(1));
    rerender(<DeviceRevoked onEraseLocalCopy={onEraseLocalCopy} onDismiss={() => {}} />);
    expect(onEraseLocalCopy).toHaveBeenCalledTimes(1);
  });

  it("still explains when the erase itself fails", async () => {
    // A failed unlink leaves an encrypted container this device can no longer
    // obtain a token for. That is not a second thing to explain, and swapping
    // the disclosure for an error would drop the only sentence on the screen
    // that tells the user what happened to their data.
    const onEraseLocalCopy = vi.fn(async () => {
      throw new Error("opfs gone");
    });
    render(<DeviceRevoked onEraseLocalCopy={onEraseLocalCopy} onDismiss={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("device-revoked.root").getAttribute("data-erased")).toBe("true"),
    );
    expect(screen.getByTestId("device-revoked.disclosure").textContent).toBe(
      DEVICE_REVOKED_DISCLOSURE,
    );
  });

  it("renders the disclosure verbatim", async () => {
    render(<DeviceRevoked onEraseLocalCopy={async () => {}} onDismiss={() => {}} />);
    expect(screen.getByTestId("device-revoked.disclosure").textContent).toBe(
      DEVICE_REVOKED_DISCLOSURE,
    );
  });

  it("claims a LOCAL deletion and never a remote wipe or a lockout", () => {
    const text = DEVICE_REVOKED_DISCLOSURE.toLowerCase();
    // The claim it must make.
    expect(text).toContain("local");
    // The claims it must not. A user cut off from an account should not be told
    // the server reached into their machine, and should not be told their
    // account is gone.
    expect(text).not.toMatch(/remote wipe/);
    expect(text).not.toMatch(/wiped|destroyed your account|account deleted/);
    // And the real loss is named, not buried.
    expect(text).toContain("not synced");
  });

  it("agrees with what the removing device was promised", () => {
    // The two literals are read by two different people about one event. This
    // pins that neither has drifted into contradicting the other: the removal
    // side says it is not a remote wipe, and the revoked side says the deletion
    // was local.
    expect(REMOVE_DEVICE_DISCLOSURE.toLowerCase()).toContain("not a remote wipe");
    expect(DEVICE_REVOKED_DISCLOSURE.toLowerCase()).toContain("not something the server");
  });

  it("offers a way out that re-enters the boot probe", () => {
    const onDismiss = vi.fn();
    render(<DeviceRevoked onEraseLocalCopy={async () => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId("device-revoked.cta"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("announces itself to assistive tech", () => {
    render(<DeviceRevoked onEraseLocalCopy={async () => {}} onDismiss={() => {}} />);
    const root = screen.getByTestId("device-revoked.root");
    expect(root.getAttribute("role")).toBe("alert");
    expect(root.getAttribute("aria-live")).toBe("assertive");
  });
});
