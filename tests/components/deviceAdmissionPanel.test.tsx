// @vitest-environment jsdom

// The two-sided device admission ceremony's STOP arm (myne-md/myne#938 task 11,
// `decisions/protocol/0762`).
//
// The claim under test is one sentence from the decision: a mismatch is a STOP on
// both sides, never a retry. The panel used to reach it by calling its own
// `onCancel`, whose `finally` runs `reset()`: `stopped` was cleared in the same
// tick it was set, the surface closed, and the line that says the two screens did
// not match existed for one frame. Nothing caught that, because the desktop E2E
// scenario drives the ceremony on two devices and asserts the resulting STATE
// rather than this component's rendering (myne-md/myne#938 review).

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  confirmJoining: vi.fn(),
  preview: vi.fn(),
  accept: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/lib/deviceAdmission", () => ({
  startDeviceAdmission: mocks.start,
  confirmJoiningDevice: mocks.confirmJoining,
  previewDeviceAdmission: mocks.preview,
  acceptAdmittingDevice: mocks.accept,
  cancelDeviceAdmission: mocks.cancel,
  deviceAdmissionErrorKind: () => "Generic",
}));

const toastMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/components/toast/toastStore", () => ({ toast: toastMock }));

import { DeviceAdmissionPanel } from "../../src/components/sync/DeviceAdmissionPanel";

const MINTED = {
  code: "MYNE-DEVICE-1:aa:bb:cc:dd:ee:1:ff:00",
  sas: "1a2b3c4d-",
  person_id_hex: "aa",
  device_id_hex: "bb",
};

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  toastMock.mockReset();
  mocks.start.mockResolvedValue(MINTED);
  mocks.preview.mockResolvedValue({
    code: MINTED.code,
    sas: MINTED.sas,
    device_id_hex: "bb",
    person_id_hex: "aa",
    person_fingerprint_hex: "cc",
  });
  mocks.cancel.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("DeviceAdmissionPanel", () => {
  it("leaves the stop line standing when the two screens do not match", async () => {
    render(<DeviceAdmissionPanel personIdHex="aa" />);

    fireEvent.click(screen.getByTestId("sync.device-admission.join-open"));
    fireEvent.click(screen.getByTestId("sync.device-admission.join-start"));
    await screen.findByTestId("sync.device-admission.sas");

    // The human says the two screens do NOT show the same eight characters.
    fireEvent.click(screen.getByTestId("sync.device-admission.join-mismatch"));

    // Wait for the ceremony to SETTLE first, then assert. Asserting the stop line
    // immediately would pass against the defect: `setStopped(true)` renders before
    // the `await` inside `onMismatch`, so the line is briefly on screen even when
    // the teardown clears it in the same batch (myne-md/myne#938 review, and the
    // reason this test is ordered this way). The settled state is the start
    // buttons being back, which only the `finally` produces.
    await waitFor(() =>
      expect(screen.getByTestId("sync.device-admission.join-open")).toBeTruthy(),
    );
    expect(screen.getByTestId("sync.device-admission.stopped")).toBeTruthy();
    expect(screen.queryByTestId("sync.device-admission.sas")).toBeNull();

    // The minted admission is dropped on the backend too, so the code the user
    // just rejected cannot be confirmed later by a peer that kept its screen open.
    expect(mocks.cancel).toHaveBeenCalledTimes(1);

    // And the surface is back at its start, not at a retry of the same code.
    expect(screen.getByTestId("sync.device-admission.admit-open")).toBeTruthy();
  });

  it("clears the stop line when the user opens a new ceremony", async () => {
    // The other half: `stopped` is terminal for that attempt, not for the panel.
    // Without this, "leave it standing" could be satisfied by never clearing it.
    render(<DeviceAdmissionPanel personIdHex="aa" />);

    fireEvent.click(screen.getByTestId("sync.device-admission.join-open"));
    fireEvent.click(screen.getByTestId("sync.device-admission.join-start"));
    await screen.findByTestId("sync.device-admission.sas");
    fireEvent.click(screen.getByTestId("sync.device-admission.join-mismatch"));
    await screen.findByTestId("sync.device-admission.stopped");
    await waitFor(() =>
      expect(screen.getByTestId("sync.device-admission.admit-open")).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId("sync.device-admission.admit-open"));
    expect(screen.queryByTestId("sync.device-admission.stopped")).toBeNull();
  });

  it("reports a cancel that could not reach the backend instead of reading as a clean stop", async () => {
    // The empty `catch` this replaced could not fail any test, which is how it
    // survived the first review round (myne-md/myne#938 review). A cancel is the
    // call that REVOKES the minted admission, so a rejection leaves the code the
    // user just rejected confirmable by a peer that kept its screen open; the
    // surface says so rather than showing the stop line alone.
    mocks.cancel.mockRejectedValue(new Error("transport"));
    render(<DeviceAdmissionPanel personIdHex="aa" />);

    fireEvent.click(screen.getByTestId("sync.device-admission.join-open"));
    fireEvent.click(screen.getByTestId("sync.device-admission.join-start"));
    await screen.findByTestId("sync.device-admission.sas");
    fireEvent.click(screen.getByTestId("sync.device-admission.join-mismatch"));

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(toastMock.mock.calls[0]?.[0]).toMatchObject({
      message: "sync.deviceAdmission.error.cancelFailed",
      variant: "error",
    });
    // And the stop line still stands: reporting the failure does not reopen the
    // ceremony, because a mismatch is terminal for that attempt either way.
    expect(screen.getByTestId("sync.device-admission.stopped")).toBeTruthy();
  });
});
