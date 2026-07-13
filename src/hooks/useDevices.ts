// `useDevices` — the device roster + approve/remove actions (MYND-425 tasks 7/8).
// Wired to the `sync` plugin's authed device commands (which talk to the server
// /auth/devices* surface over the configured transport).

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** One device in the roster (mirrors the Rust `DeviceEntry`). */
export interface DeviceEntry {
  device_id_hex: string;
  approved: boolean;
  retired: boolean;
  /** True for the device this client is running on (marked by the backend). Optional
   *  to mirror the Rust `#[serde(default)]` — a roster row may arrive without it. */
  is_current?: boolean;
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
  /** Approve a pending device. Resolves `true` on success, `false` if the
   *  backend call failed (the error is surfaced via `error`); callers that gate
   *  a follow-up step on approval — e.g. the SAS verify screen — must check it. */
  approve: (deviceIdHex: string) => Promise<boolean>;
  /** Remove (revoke) a device. */
  remove: (deviceIdHex: string) => Promise<void>;
  /** Reset THIS device's local sync enrollment — clear its stale per-device token +
   *  sync baseline so it can be re-added. The recovery path when the token is rejected
   *  (Unauthenticated / NotEnrolled). Never touches notes; makes no server call. */
  resetLocal: () => Promise<void>;
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

  // `silent` poll loads don't toggle `busy` (no button flicker) and swallow
  // transient errors / keep the last-good roster — only an explicit refresh or
  // action surfaces failure. The background poll is what makes a newly-joined
  // device appear without reopening Settings (MYND-425 follow-up).
  const load = useCallback(async (silent: boolean) => {
    if (!silent) setBusy(true);
    try {
      const roster = await invoke<DeviceEntry[]>("plugin:sync|sync_list_devices");
      setDevices(roster);
      setError(null);
    } catch (e) {
      if (!silent) setError(errKind(e));
    } finally {
      if (!silent) setBusy(false);
    }
  }, []);

  const refresh = useCallback(() => load(false), [load]);

  useEffect(() => {
    void load(false);
    // Silent roster poll so a newly-joined device surfaces without reopening
    // Settings. 2s during the (bounded, user-initiated) enrollment window — NOT the
    // steady-state background sync cadence.
    const id = setInterval(() => void load(true), 2000);
    // Re-read immediately on a local enrollment change (e.g. reset) so the roster
    // does not lag its 4s poll behind the status indicator.
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen("sync://enrollment-changed", () => void load(false)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      clearInterval(id);
      unlisten?.();
    };
  }, [load]);

  const approve = useCallback(
    async (deviceIdHex: string): Promise<boolean> => {
      setBusy(true);
      try {
        await invoke("plugin:sync|sync_approve_device", { deviceIdHex });
        await refresh();
        return true;
      } catch (e) {
        setError(errKind(e));
        setBusy(false);
        return false;
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

  const resetLocal = useCallback(async () => {
    setBusy(true);
    try {
      await invoke("plugin:sync|sync_reset_local");
      await refresh();
    } catch (e) {
      setError(errKind(e));
      setBusy(false);
    }
  }, [refresh]);

  const pending = (devices ?? []).filter((d) => !d.approved && !d.retired);

  return { devices, pending, error, busy, refresh, approve, remove, resetLocal };
}
