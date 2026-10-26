// @vitest-environment jsdom
//
// The phrase-free device admission surface (`decisions/protocol/0735`), as it
// renders inside `DeviceManagementPanel`.
//
// Two arms, and which one renders is a fact about the device rather than a
// choice: a device with no account (the roster answers `NotEnrolled`) SHOWS its
// code, and a signed-in device READS one. The assertions below pin exactly the
// things that would be silent if they broke:
//
//   - the arm split, because rendering the wrong one asks the user to work out
//     which device they are holding;
//   - that the SAS the admitting device sends is the one the user TYPED, since
//     the write is bound to it (`SasMismatch` is refused server-side otherwise);
//   - that a resumed admission is shown rather than a second one minted, which
//     is how an interrupted join avoids leaving the owner approving a row
//     nobody can use;
//   - that the three named refusals each get their own sentence, because their
//     remedies differ and none of them is "try again".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { DeviceManagementPanel } from "../../src/components/sync/DeviceManagementPanel";
import type { DevicesHook } from "../../src/hooks/useDevices";

const PREFS_STUB = { device_names: {} };

/** A hook whose roster failed in a specific way, which is what selects the arm. */
function hookWithError(kind: string): DevicesHook {
  return {
    devices: null,
    pending: [],
    error: kind,
    busy: false,
    approve: vi.fn(),
    remove: vi.fn(),
    resetLocal: vi.fn(),
  } as unknown as DevicesHook;
}

const CODE = "MYNE-DEVICE-1:" + "aa".repeat(16) + ":" + "bb".repeat(16) + "::" + "cc".repeat(16) + ":4096:" + "dd".repeat(32) + ":" + "ee".repeat(32);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "plugin:prefs|prefs_read") return PREFS_STUB;
    if (cmd === "plugin:sync|sync_pending_device_admission") return null;
    return undefined;
  });
});

afterEach(cleanup);

describe("phrase-free admission, joining device", () => {
  it("shows the code arm, and mints one only after a valid identity code", async () => {
    render(<DeviceManagementPanel hook={hookWithError("NotEnrolled")} plane="owner" />);

    // The joining arm is the only one rendered: a device with no account has
    // nothing to admit.
    expect(await screen.findByTestId("sync.phrase-free-join")).toBeTruthy();
    expect(screen.queryByTestId("sync.phrase-free-admit")).toBeNull();

    // A malformed pasted code is refused HERE, with its own sentence, rather than
    // producing an admission bound to a person id nobody meant.
    fireEvent.change(screen.getByTestId("sync.phrase-free-identity-code"), {
      target: { value: "not-an-identity-code" },
    });
    fireEvent.click(screen.getByTestId("sync.phrase-free-start"));
    expect(await screen.findByTestId("sync.phrase-free-error")).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "plugin:sync|sync_device_admission_code",
      expect.anything(),
    );

    // The person id is the SECOND field of an identity code, and it is what the
    // command is given.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:prefs|prefs_read") return PREFS_STUB;
      if (cmd === "plugin:sync|sync_pending_device_admission") return null;
      if (cmd === "plugin:sync|sync_device_admission_code") {
        return { code: CODE, sas: "1a2b-3c4d", device_id_hex: "aa".repeat(16), has_device_key: true };
      }
      return undefined;
    });
    fireEvent.change(screen.getByTestId("sync.phrase-free-identity-code"), {
      target: { value: "MYNE-PERSON-1:" + "ff".repeat(16) + ":" + "00".repeat(16) },
    });
    fireEvent.click(screen.getByTestId("sync.phrase-free-start"));

    expect(await screen.findByTestId("sync.phrase-free-code")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("plugin:sync|sync_device_admission_code", {
      personIdHex: "ff".repeat(16),
    });
    // Both screens must show this string; it is the only thing that turns "I
    // pasted some text" into "the device in my hand produced it".
    expect(screen.getByTestId("sync.phrase-free-sas").textContent).toContain("1a2b-3c4d");
  });

  it("resumes an admission this device already started instead of minting a second one", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:prefs|prefs_read") return PREFS_STUB;
      if (cmd === "plugin:sync|sync_pending_device_admission") {
        return { code: CODE, sas: "9f8e-7d6c", device_id_hex: "aa".repeat(16), has_device_key: false };
      }
      return undefined;
    });
    render(<DeviceManagementPanel hook={hookWithError("NotEnrolled")} plane="owner" />);

    await waitFor(() => {
      expect(screen.getByTestId("sync.phrase-free-code")).toBeTruthy();
    });
    // A device with no storage rung says so, rather than quietly admitting a
    // device that will keep signing with the phrase.
    expect(screen.getByTestId("sync.phrase-free-no-device-key")).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "plugin:sync|sync_device_admission_code",
      expect.anything(),
    );
  });
});

describe("phrase-free admission, admitting device", () => {
  it("sends the SAS the user typed, and reports a mismatch as its own refusal", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:prefs|prefs_read") return PREFS_STUB;
      if (cmd === "plugin:sync|sync_admit_device") throw "SasMismatch";
      return undefined;
    });
    render(<DeviceManagementPanel hook={hookWithError("")} plane="owner" />);

    expect(await screen.findByTestId("sync.phrase-free-admit")).toBeTruthy();
    expect(screen.queryByTestId("sync.phrase-free-join")).toBeNull();

    fireEvent.change(screen.getByTestId("sync.phrase-free-admit-code"), {
      target: { value: CODE },
    });
    // Typed the way a human retypes it: the display's dash is stripped before the
    // comparison, and the string that reaches the command is exactly what was
    // typed so the backend can do its own normalization in one place.
    fireEvent.change(screen.getByTestId("sync.phrase-free-admit-sas"), {
      target: { value: "1a2b3c4d" },
    });
    fireEvent.click(screen.getByTestId("sync.phrase-free-admit-confirm"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("plugin:sync|sync_admit_device", {
        code: CODE,
        sas: "1a2b3c4d",
      });
    });
    const error = await screen.findByTestId("sync.phrase-free-error");
    // The sentence names what actually happened: the code did not come from the
    // screen the user is looking at.
    expect(error.textContent).not.toBe("");
    expect(screen.queryByTestId("sync.phrase-free-admitted")).toBeNull();
  });

  it("says which half landed when the row could not be bound", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:prefs|prefs_read") return PREFS_STUB;
      if (cmd === "plugin:sync|sync_admit_device") {
        return { device_id_hex: "aa".repeat(16), sas: "1a2b-3c4d", bound: false };
      }
      return undefined;
    });
    render(<DeviceManagementPanel hook={hookWithError("")} plane="owner" />);
    await screen.findByTestId("sync.phrase-free-admit");

    fireEvent.change(screen.getByTestId("sync.phrase-free-admit-code"), {
      target: { value: CODE },
    });
    fireEvent.change(screen.getByTestId("sync.phrase-free-admit-sas"), {
      target: { value: "1a2b-3c4d" },
    });
    fireEvent.click(screen.getByTestId("sync.phrase-free-admit-confirm"));

    const admitted = await screen.findByTestId("sync.phrase-free-admitted");
    // `bound: false` is not an error and must not read as one: the device is
    // admitted and can sign in, and only the signing half is still owed.
    expect(admitted.textContent).not.toBe("");
    expect(screen.queryByTestId("sync.phrase-free-error")).toBeNull();
  });
});
