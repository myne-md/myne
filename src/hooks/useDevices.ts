// `useDevices` — the device roster + approve/remove actions (MYND-425 tasks 7/8).
// Wired to the `sync` plugin's authed device commands (which talk to the server
// /auth/devices* surface over the configured transport).

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** One device in the roster (mirrors the Rust `DeviceEntry`). */
export interface DeviceEntry {
  device_id_hex: string;
  approved: boolean;
  retired: boolean;
}

/** A serialized `SyncDeviceError` from the plugin. */
interface SyncDeviceError {
  kind: string;
}

export interface DevicesHook {
  /** The roster, or `null` until the first load resolves. */
  devices: DeviceEntry[] | null;
  /** Pending (awaiting-approval) devices, derived from the roster. */
  pending: DeviceEntry[];
  /** A non-secret error kind from the last action, or null. */
  error: string | null;
  /** Whether a load/action is in flight. */
  busy: boolean;
  /** Re-read the roster. */
  refresh: () => Promise<void>;
  /** Approve a pending device. */
  approve: (deviceIdHex: string) => Promise<void>;
  /** Remove (revoke) a device. */
  remove: (deviceIdHex: string) => Promise<void>;
}

function errKind(e: unknown): string {
  if (e && typeof e === "object" && "kind" in e) {
    return (e as SyncDeviceError).kind;
  }
  return "Internal";
}

export function useDevices(): DevicesHook {
  const [devices, setDevices] = useState<DeviceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const roster = await invoke<DeviceEntry[]>("plugin:sync|sync_list_devices");
      setDevices(roster);
      setError(null);
    } catch (e) {
      setError(errKind(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const approve = useCallback(
    async (deviceIdHex: string) => {
      setBusy(true);
      try {
        await invoke("plugin:sync|sync_approve_device", { deviceIdHex });
        await refresh();
      } catch (e) {
        setError(errKind(e));
        setBusy(false);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (deviceIdHex: string) => {
      setBusy(true);
      try {
        await invoke("plugin:sync|sync_remove_device", { deviceIdHex });
        await refresh();
      } catch (e) {
        setError(errKind(e));
        setBusy(false);
      }
    },
    [refresh],
  );

  const pending = (devices ?? []).filter((d) => !d.approved && !d.retired);

  return { devices, pending, error, busy, refresh, approve, remove };
}
