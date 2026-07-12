// Mobile sync command surface — thin `invoke` wrappers + the enroll / device-roster
// hooks that the Settings sync panels consume. Ports the desktop `useEnroll`
// (`src/hooks/useEnroll.ts`) + `useDevices` (`src/hooks/useDevices.ts`) 1:1 over the
// mobile-registered `sync` plugin (MYND-458), with PLAIN English strings (mobile has
// no i18n) and the load-bearing enroll/revoke copy imported verbatim from `@myne/copy`
// (SYNC-42 — cross-client paraphrase is impossible by construction).
//
// Secret discipline: the credential (password / 24-word phrase) is passed per-call
// straight to IPC and never parked in module or hook state.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ── Endpoint config (SY-02) ──────────────────────────────────────────────────

/** Where a cert pin came from (SYNC-43): a pre-vetted hosted static pin vs a
 *  TOFU pin captured at first connect (the one the user eye-compares). */
export type PinSource = "static" | "tofu";

/** Mirrors the Rust `SyncEndpointView`. */
export interface SyncEndpointView {
  endpoint_url: string | null;
  cert_pin_hex: string | null;
  pin_source: PinSource | null;
}

/** Mirrors the Rust `EndpointPinInfo` returned by `sync_set_endpoint`. */
export interface EndpointPinInfo {
  fingerprint: string | null;
  pin_source: PinSource | null;
}

export function syncGetEndpoint(): Promise<SyncEndpointView> {
  return invoke<SyncEndpointView>("plugin:sync|sync_get_endpoint");
}

/** Set (or clear, with `null`) the sync endpoint. For an `https` endpoint the
 *  core TOFU-pins the leaf cert and returns its fingerprint for eye-compare. */
export function syncSetEndpoint(endpointUrl: string | null): Promise<EndpointPinInfo> {
  return invoke<EndpointPinInfo>("plugin:sync|sync_set_endpoint", { endpointUrl });
}

// ── Join an existing account on a fresh device (Welcome → JoinFlow) ───────────

/** Mirrors the Rust `JoinResult` (`core/src/plugins/sync/commands.rs`). */
export interface JoinResult {
  /** The new local vault's id — the frontend routes to its unlocked editor. */
  vault_id: string;
  /** True when the device is pending approval by an existing device (the common
   *  password-path case); false if it was approved immediately. */
  pending: boolean;
  /** The server cert fingerprint (https) for eye-compare, or `null` (loopback). */
  fingerprint: string | null;
}

/** **Add this device to an existing account.** On a fresh device, bootstrap the
 *  whole local vault from the server: set + TOFU-pin the endpoint, fetch the
 *  account's `vault.meta` pre-auth, derive `root_key` from `{account# + password}`,
 *  write the meta to a NEW local vault + unlock it, then SCRAM-enroll (password →
 *  pending until an existing device approves). Password-only (no 24-word phrase —
 *  that variant is the deferred F3-T5 follow-up). The credential is passed straight
 *  to IPC and never parked in module/hook state (secret discipline). */
export function syncJoinAccount(
  serverUrl: string,
  accountNumber: string,
  password: string,
): Promise<JoinResult> {
  return invoke<JoinResult>("plugin:sync|sync_join_account", {
    serverUrl,
    accountNumber,
    password,
  });
}

// ── SAS eye-compare (SY-05, SYNC-40 / SYNC-17) ───────────────────────────────

/** Request an immediate sync cycle — for a still-PENDING device this re-runs the
 *  handshake and claims the per-device token if an existing device has approved
 *  it (then pulls). Returns the resulting runtime status. */
export function syncNow(): Promise<{ state: string; count?: number; detail?: string }> {
  return invoke<{ state: string; count?: number; detail?: string }>("plugin:sync|sync_now");
}

/** The 8-char Crockford `XXXX-XXXX` fingerprint of this device's currently
 *  adopted vault head (`protocol::head_fingerprint`, ONE frozen encoding —
 *  SYNC-17, no word-list, no second encoding). `null` when no head is adopted
 *  yet. Both devices show the same string once they've pulled the same head, so
 *  a match confirms the newcomer is on the genuine account (SAS eye-compare). */
export function syncHeadFingerprint(): Promise<string | null> {
  return invoke<string | null>("plugin:sync|sync_head_fingerprint");
}

/** Reset THIS device's local sync enrollment (clear the per-device token + sync
 *  baseline). Used to ABORT a join when the SAS fingerprints don't match — the
 *  device un-enrolls and stops trusting the (possibly forked) synced data. */
export function syncResetLocal(): Promise<void> {
  return invoke<void>("plugin:sync|sync_reset_local");
}

// ── Enroll (SY-03 / SY-04) ───────────────────────────────────────────────────

/** Which credential the enrolling device proves account ownership with. */
export type EnrollCredentialKind = "password" | "recovery";

/** Mirrors the Rust `EnrollResult`. */
interface EnrollResult {
  approved: boolean;
}

/** A serialized `SyncDeviceError` from the plugin (`{ kind: "…" }`). */
interface SyncDeviceError {
  kind: string;
}

/** The terminal outcome surfaced to the enroll form. `approved` = token issued
 *  and syncing; `pending` = held by the approval gate; `error` = a non-secret
 *  failure kind the form maps to honest, non-distinguishing copy. */
export type EnrollOutcome =
  | { state: "approved" }
  | { state: "pending" }
  | { state: "error"; kind: string };

export function errKind(e: unknown): string {
  if (e && typeof e === "object" && "kind" in e) {
    return (e as SyncDeviceError).kind;
  }
  return "Internal";
}

export interface EnrollHook {
  busy: boolean;
  outcome: EnrollOutcome | null;
  enroll: (
    accountNumber: string,
    credential: string,
    credentialKind: EnrollCredentialKind,
  ) => Promise<void>;
  reset: () => void;
}

export function useEnroll(): EnrollHook {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<EnrollOutcome | null>(null);

  const enroll = useCallback(
    async (
      accountNumber: string,
      credential: string,
      credentialKind: EnrollCredentialKind,
    ) => {
      setBusy(true);
      setOutcome(null);
      try {
        const result = await invoke<EnrollResult>("plugin:sync|sync_enroll", {
          accountNumber,
          credential,
          credentialKind,
        });
        setOutcome(result.approved ? { state: "approved" } : { state: "pending" });
      } catch (e) {
        setOutcome({ state: "error", kind: errKind(e) });
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const reset = useCallback(() => setOutcome(null), []);

  return { busy, outcome, enroll, reset };
}

// ── Device roster (SY-05 approve / SY-06 list / SY-07 remove) ─────────────────

/** One device in the roster (mirrors the Rust `DeviceEntry`). */
export interface DeviceEntry {
  device_id_hex: string;
  approved: boolean;
  retired: boolean;
  /** True for the device this client runs on (marked backend-side). Optional to
   *  mirror the Rust `#[serde(default)]`. */
  is_current?: boolean;
}

export interface DevicesHook {
  devices: DeviceEntry[] | null;
  pending: DeviceEntry[];
  error: string | null;
  busy: boolean;
  refresh: () => Promise<void>;
  /** Approve a pending device. Resolves `true` on success, `false` if the
   *  backend call failed (the error is surfaced via `error`); callers that gate
   *  a follow-up step on approval — e.g. the SAS verify screen — must check it. */
  approve: (deviceIdHex: string) => Promise<boolean>;
  remove: (deviceIdHex: string) => Promise<void>;
  /** Reset THIS device's local enrollment (clear stale token + baseline) so it
   *  can be re-added — the recovery path when the token is rejected. */
  resetLocal: () => Promise<void>;
}

export function useDevices(): DevicesHook {
  const [devices, setDevices] = useState<DeviceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    const id = setInterval(() => void load(true), 4000);
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
