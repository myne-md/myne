// @vitest-environment jsdom
//
// The mobile half of the two-sided device admission ceremony (myne-md/myne#938
// task 11, `decisions/protocol/0735`), asserted through the hub that mounts it.
//
// Three claims, each one a defect a review round found:
//
//  1. The ceremony is REACHABLE in every state, not only while this device is
//     waiting for approval. It used to sit inside `status.state === "pending"`,
//     so "approve a device on this vault" was unreachable exactly when it could
//     work: a pending phone holds no credential and cannot admit anyone, and a
//     signed-in phone never rendered the block at all.
//  2. A safety-code mismatch is a STOP that STAYS on screen. It shared the
//     dismiss path, whose teardown clears every field, so the stop line rendered
//     for one frame and "a mismatch stops both sides" was a claim nothing held.
//  3. The code is copied through the SECRET path and the outcome is visible,
//     because the admission code is credential-equivalent (both SCRAM verifier
//     halves) and the only way to move it was to select a read-only input by
//     hand.
//
// `useTranslation` returns the KEY, so an assertion names the catalog entry the
// user would see rather than a copy string that can be reworded underneath it.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-i18next")>();
  return { ...real, useTranslation: () => ({ t: (key: string) => key }) };
});

const invokeMock = vi.fn((cmd: string) => {
  if (cmd === "plugin:sync|sync_get_endpoint") return Promise.resolve({ endpoint_url: null });
  if (cmd === "plugin:sync|sync_member_vault_status") {
    return Promise.resolve({ is_member_vault: false, has_credential: false, method: null });
  }
  if (cmd === "plugin:sync|sync_person_status") {
    return Promise.resolve({ person_id_hex: "ab".repeat(16) });
  }
  return Promise.resolve(undefined);
});

vi.mock("../../src/platform/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/platform/core")>();
  return { ...real, invoke: (...args: unknown[]) => invokeMock(args[0] as string) };
});

const copyMock = vi.fn();
vi.mock("../../src/lib/secret-export", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/secret-export")>();
  return { ...real, copySecretToClipboard: (...args: unknown[]) => copyMock(...args) };
});

const previewMock = vi.fn();
const cancelMock = vi.fn();
const startMock = vi.fn();
vi.mock("../../src/lib/deviceAdmission", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/deviceAdmission")>();
  return {
    ...real,
    startDeviceAdmission: (...args: unknown[]) => startMock(...args),
    previewDeviceAdmission: (...args: unknown[]) => previewMock(...args),
    cancelDeviceAdmission: () => cancelMock(),
  };
});

import { SyncHubPanel } from "../../src/components/SyncSettingsPanels";
import type { SyncStatus } from "../../src/lib/use-sync-status";

/** A signed-in status: NOT `pending`, which is the state the old gate excluded. */
const SYNCED = { state: "idle", detail: null } as unknown as SyncStatus;

function mount() {
  render(
    <SyncHubPanel
      status={SYNCED}
      onSyncNow={() => {}}
      syncing={false}
      onOpenEndpoint={() => {}}
      onOpenEnroll={() => {}}
      onOpenDevices={() => {}}
      onOpenMembers={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  invokeMock.mockClear();
  copyMock.mockReset();
  previewMock.mockReset();
  cancelMock.mockReset();
  startMock.mockReset();
});

describe("the admission ceremony is reachable from a synced hub", () => {
  it("renders the ceremony when this device is NOT waiting for approval", async () => {
    mount();
    expect(screen.getByTestId("sync.device-admission")).toBeTruthy();
    // The pending notice is the thing that used to gate the whole block, and it
    // is still gated: a signed-in device is not waiting for anything.
    expect(screen.queryByTestId("sync.settings.awaiting-approval")).toBeNull();
  });

  it("keeps the stop line on screen after a mismatch, and cancels server-side", async () => {
    previewMock.mockResolvedValue({
      sas: "abcd-1234",
      device_id_hex: "cd".repeat(16),
      has_device_key: true,
    });
    cancelMock.mockResolvedValue(undefined);
    mount();

    // The `admit` segment is the second radio in the ceremony's segmented control.
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    fireEvent.click(radios[1]);

    fireEvent.change(screen.getByTestId("sync.device-admission.admit-code"), {
      target: { value: "MYNE-DEVICE-1:deadbeef" },
    });
    fireEvent.click(screen.getByTestId("sync.device-admission.admit-preview"));

    await waitFor(() => expect(screen.getByTestId("sync.device-admission.admit-sas")).toBeTruthy());

    fireEvent.click(screen.getByTestId("sync.device-admission.admit-mismatch"));

    await waitFor(() => expect(cancelMock).toHaveBeenCalled());
    // The line survives the teardown, which is the whole point: the shared reset
    // clears `stopped`, so this assertion fails against that shape.
    await waitFor(() =>
      expect(screen.getByTestId("sync.device-admission.stopped").textContent).toBe(
        "sync.deviceAdmission.stopped",
      ),
    );
  });

  it("copies the minted code through the secret path and says what happened", async () => {
    copyMock.mockImplementation(
      (_value: string, feedback: { onSuccess: { run: () => void } }) => {
        feedback.onSuccess.run();
        return Promise.resolve(() => {});
      },
    );
    startMock.mockResolvedValue({
      code: "MYNE-DEVICE-1:00ff",
      sas: "1234-abcd",
      has_device_key: true,
    });
    mount();

    // `personStatus` is an effect, so the start button is disabled on the first
    // frame: clicking it before the probe resolves is a no-op, and the failure
    // reads as "the mint did not land".
    const start = screen.getByTestId("sync.device-admission.join-start");
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    // The copy control only exists once a code is on screen, so finding it is
    // also the assertion that the mint landed.
    const copy = await screen.findByTestId("sync.device-admission.copy");
    fireEvent.click(copy);
    await waitFor(() =>
      expect(screen.getByTestId("sync.device-admission.copy-outcome").textContent).toBe(
        "sync.deviceAdmission.join.copied",
      ),
    );
    expect(copyMock).toHaveBeenCalledWith(
      "MYNE-DEVICE-1:00ff",
      expect.objectContaining({ onSuccess: expect.anything() }),
    );
  });
});
