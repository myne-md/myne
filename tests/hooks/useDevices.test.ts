// @vitest-environment jsdom
//
// `useDevices` (MYND-425 tasks 7/8): the device roster + approve/remove
// actions, wired to the `sync` plugin's authed device commands. The Tauri
// `invoke` shim is mocked at the module seam; we dispatch by command name so a
// single mock services the list/approve/remove surface. Assertions pin:
//   - the roster load splits approved vs pending (the hook's `approved` /
//     `retired` filter for `pending`);
//   - approve(hex)/remove(hex) cross the IPC boundary with the exact command
//     name + hex id;
//   - the `busy` flag gates during an in-flight mutation;
//   - a rejected IPC sets the non-secret `error` kind.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useDevices, type DeviceEntry } from "../../src/hooks/useDevices";

// A roster fixture covering the three roster shapes the hook filters on:
// an approved device, a pending (awaiting-approval) device, and a retired one.
const APPROVED: DeviceEntry = {
  device_id_hex: "aa00",
  approved: true,
  retired: false,
};
const PENDING: DeviceEntry = {
  device_id_hex: "bb11",
  approved: false,
  retired: false,
};
const RETIRED: DeviceEntry = {
  device_id_hex: "cc22",
  approved: false,
  retired: true,
};

const ROSTER = [APPROVED, PENDING, RETIRED];

beforeEach(() => {
  // Default: every command resolves. List returns the full roster; mutations
  // resolve undefined. Tests that need a specific path override per-call.
  invokeMock.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === "plugin:sync|sync_list_devices") return ROSTER;
    return undefined;
  });
});

afterEach(() => {
  invokeMock.mockReset();
});

describe("useDevices — roster load + split", () => {
  it("loads the roster on mount and exposes the full list", async () => {
    const { result } = renderHook(() => useDevices());
    // Synchronous initial render is pre-load.
    expect(result.current.devices).toBeNull();
    await waitFor(() => expect(result.current.devices).toEqual(ROSTER));
    expect(invokeMock).toHaveBeenCalledWith("plugin:sync|sync_list_devices");
  });

  it("derives `pending` as the awaiting-approval set (not approved, not retired)", async () => {
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.devices).toEqual(ROSTER));

    // Pending excludes the approved AND the retired entries — only PENDING.
    expect(result.current.pending).toEqual([PENDING]);
    // The approved device is in the roster but not in pending.
    expect(result.current.devices).toContainEqual(APPROVED);
    expect(result.current.pending).not.toContainEqual(APPROVED);
    // The retired device is in the roster but not in pending either.
    expect(result.current.devices).toContainEqual(RETIRED);
    expect(result.current.pending).not.toContainEqual(RETIRED);
  });
});

describe("useDevices — approve", () => {
  it("invokes sync_approve_device with the exact hex id, then refreshes", async () => {
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.devices).toEqual(ROSTER));
    invokeMock.mockClear();

    await act(async () => {
      await result.current.approve("bb11");
    });

    expect(invokeMock).toHaveBeenCalledWith("plugin:sync|sync_approve_device", {
      deviceIdHex: "bb11",
    });
    // A successful approve re-reads the roster.
    expect(invokeMock).toHaveBeenCalledWith("plugin:sync|sync_list_devices");
  });
});

describe("useDevices — remove", () => {
  it("invokes sync_remove_device with the exact hex id, then refreshes", async () => {
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.devices).toEqual(ROSTER));
    invokeMock.mockClear();

    await act(async () => {
      await result.current.remove("aa00");
    });

    expect(invokeMock).toHaveBeenCalledWith("plugin:sync|sync_remove_device", {
      deviceIdHex: "aa00",
    });
    expect(invokeMock).toHaveBeenCalledWith("plugin:sync|sync_list_devices");
  });
});

describe("useDevices — busy gating", () => {
  it("holds busy=true across an in-flight mutation and drops it once the refresh settles", async () => {
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.busy).toBe(false));

    // Gate the approve mutation behind a manually-released promise so we can
    // observe `busy` mid-flight (between the IPC call and its resolution).
    let releaseApprove: () => void = () => {};
    const approveGate = new Promise<void>((res) => {
      releaseApprove = res;
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_approve_device") {
        await approveGate;
        return undefined;
      }
      if (cmd === "plugin:sync|sync_list_devices") return ROSTER;
      return undefined;
    });

    let approvePromise: Promise<void> = Promise.resolve();
    act(() => {
      approvePromise = result.current.approve("bb11");
    });

    // Mid-flight: the mutation has not resolved → busy must be set.
    await waitFor(() => expect(result.current.busy).toBe(true));

    await act(async () => {
      releaseApprove();
      await approvePromise;
    });

    // After the mutation + its refresh settle, the gate releases.
    await waitFor(() => expect(result.current.busy).toBe(false));
  });
});

describe("useDevices — error surface", () => {
  it("sets the non-secret error kind when the roster load rejects", async () => {
    invokeMock.mockReset().mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_list_devices") {
        throw { kind: "Unauthorized" };
      }
      return undefined;
    });
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.error).toBe("Unauthorized"));
    expect(result.current.devices).toBeNull();
  });

  it("sets the error kind when an approve mutation rejects", async () => {
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.devices).toEqual(ROSTER));

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_approve_device") {
        throw { kind: "Forbidden" };
      }
      if (cmd === "plugin:sync|sync_list_devices") return ROSTER;
      return undefined;
    });

    await act(async () => {
      await result.current.approve("bb11");
    });

    expect(result.current.error).toBe("Forbidden");
    // The failed-mutation path also clears busy so the user can retry.
    expect(result.current.busy).toBe(false);
  });

  it("falls back to 'Internal' when the rejection is not a SyncDeviceError", async () => {
    invokeMock.mockReset().mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_list_devices") {
        throw new Error("opaque transport failure");
      }
      return undefined;
    });
    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.error).toBe("Internal"));
  });
});
