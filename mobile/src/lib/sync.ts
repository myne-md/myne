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
import { invoke } from "../platform/core";
import { setDeviceName } from "./prefs";
import { listen } from "../platform/event";

// ── Endpoint config (SY-02) ──────────────────────────────────────────────────

/**
 * How the endpoint's certificate is verified (SYNC-43). The wire name is
 * historical: it used to distinguish a pre-vetted hosted static pin from a TOFU
 * pin captured at first connect, and both are gone (decisions/sync/0620). The one
 * remaining value means "public CA roots plus hostname": the bundled Mozilla
 * bundle natively, the browser's own trust store on web.
 */
export type PinSource = "platform_trust_store";

/** Mirrors the Rust `SyncEndpointView`. */
export interface SyncEndpointView {
  endpoint_url: string | null;
  cert_pin_hex: string | null;
  pin_source: PinSource | null;
  /** The stored invite code for a gated server, or null when none is needed. */
  invite_code: string | null;
}

/** Mirrors the Rust `EndpointPinInfo` returned by `sync_set_endpoint`. */
export interface EndpointPinInfo {
  fingerprint: string | null;
  pin_source: PinSource | null;
}

export function syncGetEndpoint(): Promise<SyncEndpointView> {
  return invoke<SyncEndpointView>("plugin:sync|sync_get_endpoint");
}

/** Set (or clear) the sync endpoint. Native TLS verifies CA roots and hostname.
 *  `inviteCode` is the shared admission code for a gated server; omit it for an
 *  open one. Device-local, sent only on registration. */
export function syncSetEndpoint(
  endpointUrl: string | null,
  inviteCode?: string,
): Promise<EndpointPinInfo> {
  return invoke<EndpointPinInfo>("plugin:sync|sync_set_endpoint", {
    endpointUrl,
    inviteCode: inviteCode ?? null,
  });
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
  /** The device_id this join registered (MYND-548) — used to name THIS device in
   *  its own local prefs; a pending device holds no token, so it cannot read the
   *  roster to find its own row. */
  device_id_hex: string;
  /** The join used the recovery phrase (myne-md/myne#837): the vault is then
   *  `Slot::Recovering`, NOT unlocked, and the mandatory chained password reset
   *  is owed before the device can be used. False on the password path. */
  needs_password_reset: boolean;
}

/** **Add this device to an existing account.** On a fresh device, bootstrap the
 *  whole local vault from the server: verify the endpoint, fetch the
 *  account's `vault.meta` pre-auth, derive `root_key` from `{credential +
 *  account#}`, write the meta to a NEW local vault + unlock it, then SCRAM-enroll
 *  (password → pending until an existing device approves; the recovery phrase
 *  self-approves by design). `credentialKind` picks which of the two the
 *  credential is; the wire value is the Rust enum's own lowercase spelling
 *  (`core/src/plugins/sync/enroll.rs::EnrollCredential`). The credential is
 *  passed straight to IPC and never parked in module/hook state (secret
 *  discipline). */
export function syncJoinAccount(
  serverUrl: string,
  accountNumber: string,
  credential: string,
  credentialKind: EnrollCredentialKind = "password",
): Promise<JoinResult> {
  return invoke<JoinResult>("plugin:sync|sync_join_account", {
    serverUrl,
    accountNumber,
    password: credential,
    credentialKind,
  });
}

// ── Device-join via QR (MYND-466) ────────────────────────────────────────────

/** Mirrors Rust `JoinQrView` — the decoded, validated device-join QR for the
 *  confirm screen. Carries no secret (the account# is an identity; SYNC-47).
 *
 *  Tagged by `kind`, because the two targets lead to different credentials and
 *  different next steps, and the scanner must not have to guess which:
 *
 *  - `account` — the owner's device-join: the account number is prefilled and the
 *    user is asked for the vault password (`syncJoinAccount`).
 *  - `member_vault` — a shared vault this person is already a member of, being
 *    added to THIS device: the vault's account hash is prefilled and the user is
 *    asked for their 24-word recovery phrase, through the identity flow's join
 *    wizard (myne-md/myne).
 */
export type JoinQrView =
  | {
      kind: "account";
      endpoint_url: string;
      /** Canonical 20-char account number (format for display with `formatAccountNumberInput`). */
      account_number: string;
      /** False when the QR is past its ephemeral TTL (reject → re-scan). */
      fresh: boolean;
    }
  | {
      kind: "member_vault";
      endpoint_url: string;
      /** The vault's `account_number_hash`, 32 lowercase hex. Not a secret. */
      account_hash_hex: string;
      fresh: boolean;
    }
  | {
      /**
       * The PERSON (myne-md/myne#911 task 9): an owner's device-join on the
       * identity model, added to the wire in payload v3.
       *
       * Carried through rather than dropped: `JoinFlow` hands it to the shell,
       * which opens the identity flow's person-join wizard (the phrase, then the
       * owner's approval). This client's person plane is live (task 12), so the
       * person arm has somewhere to go.
       */
      kind: "person";
      endpoint_url: string;
      /** The person id, 32 lowercase hex. Public material, not a secret. */
      person_id_hex: string;
      fresh: boolean;
    };

/** Decode a scanned device-join QR string into its confirm-screen view. Rejects a
 *  non-Myne / newer-version / malformed / bad-account payload (typed `kind`). */
export function syncDecodeJoinQr(scanned: string): Promise<JoinQrView> {
  return invoke<JoinQrView>("plugin:sync|sync_decode_join_qr", { scanned });
}

/** Mirrors Rust `tauri-plugin-qr-scan`'s `ScanResponse` — the decoded QR string,
 *  or `null` when the user dismissed the scanner. */
export interface QrScanResult {
  value: string | null;
}

/** Open the iOS camera to scan a QR (device-join). Rejects with `{kind:"Unsupported"}`
 *  off iOS (SYNC-46; Android is MYND-465). */
export function scanQr(): Promise<QrScanResult> {
  return invoke<QrScanResult>("plugin:qr-scan|scan");
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

/** Declare that a SYNC-40 eye-compare is open on this device, so the sync engine
 *  holds CONTENT pushes and the vault head both screens are comparing cannot
 *  advance under them (myne#462).
 *
 *  Idempotent, and it doubles as the lease ping — call it on every poll tick.
 *  The core releases the hold after 15 s of silence and after 5 minutes
 *  regardless, so a WebView that dies mid-compare cannot leave this device
 *  silently unsynced. Pulls are never held, and the coalescing anchor is
 *  retained, so a held edit is delayed rather than dropped. */
export function syncVerifyHoldBegin(): Promise<void> {
  return invoke<void>("plugin:sync|sync_verify_hold_begin");
}

/** Release the hold — on match, on mismatch, or on unmount. Idempotent. */
export function syncVerifyHoldEnd(): Promise<void> {
  return invoke<void>("plugin:sync|sync_verify_hold_end");
}

/** Reset THIS device's local sync enrollment (clear the per-device token + sync
 *  baseline). Used to ABORT a join when the SAS fingerprints don't match — the
 *  device un-enrolls and stops trusting the (possibly forked) synced data. */
export function syncResetLocal(): Promise<void> {
  return invoke<void>("plugin:sync|sync_reset_local");
}

/** This account's own usage + effective ceilings (`GET /account/status`,
 *  MYND-570). Shape mirrors the shared-core `AccountStatusView`, which in turn
 *  mirrors the server struct — the mobile client parses nothing of its own.
 *
 *  **`0` means unlimited** for both ceilings, never a ceiling of zero: a
 *  self-hosted server (or one with no quotas set) reports `0` and the UI must
 *  show usage with no limit, no error and no upsell.
 *
 *  `null` when the projection is unavailable — sync unconfigured, this device
 *  not enrolled, or a server without the route. */
export interface AccountStatusView {
  stored_bytes: number;
  device_count: number;
  frozen: boolean;
  quota_bytes: number;
  max_devices: number;
  /**
   * `stored_bytes` is an ACCOUNT total over `vault_count` owned vaults rather
   * than one vault's own figure (myne-md/myne#911 task 11). Optional because a
   * server that predates the field omits it; the mobile person plane is task 12,
   * and the rendering arm that reads it lives beside this type so the day a
   * phone session can be a person session the figure is not misread as one
   * vault's.
   */
  person?: boolean;
  /** How many owned vaults the account total covers; absent for a vault. */
  vault_count?: number;
}

export function syncAccountStatus(): Promise<AccountStatusView | null> {
  return invoke<AccountStatusView | null>("plugin:sync|sync_account_status");
}

// ── Enroll (SY-03 / SY-04) ───────────────────────────────────────────────────

/** Which credential the enrolling device proves account ownership with. */
export type EnrollCredentialKind = "password" | "recovery";

/** Mirrors the Rust `EnrollResult`. */
interface EnrollResult {
  approved: boolean;
  /** The device_id this enrollment registered (MYND-548) — needed to name THIS
   *  device, since a pending device holds no token and so cannot read the roster
   *  to find its own row. */
  device_id_hex: string;
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
  /** `deviceName` (MYND-548) is held in RAM and written only AFTER this device's
   *  first authed sync cycle: writing it earlier would create `vault.prefs` before
   *  the cycle and disable the §10.2.1 wholesale seed, and parking it on disk
   *  would rest user-authored text outside the AEAD envelope (SYNC-3). A device
   *  that stays PENDING is not named here. */
  enroll: (
    accountNumber: string,
    credential: string,
    credentialKind: EnrollCredentialKind,
    deviceName: string,
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
      deviceName: string,
    ) => {
      setBusy(true);
      setOutcome(null);
      try {
        const result = await invoke<EnrollResult>("plugin:sync|sync_enroll", {
          accountNumber,
          credential,
          credentialKind,
        });
        if (result.approved) {
          // Approved ⇒ a cycle can run now; the seed (if any) happens inside it,
          // so naming afterwards is safe.
          try {
            await invoke("plugin:sync|sync_now");
            await setDeviceName(result.device_id_hex, deviceName);
          } catch {
            // Enrollment still succeeded; the row keeps its id-derived label.
          }
        }
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

// ── Member roster (B2B, myne-md/myne#712 task 9) ─────────────────────────────

/** One vault member as the UI consumes it (mirrors the Rust `RosterMemberView`). */
export interface RosterMemberView {
  fingerprint_hex: string;
  /** Whether this row is the caller, decided by the backend from the local
   *  person fingerprint. Never infer "You" from `role` (myne-md/myne#859). */
  is_self: boolean;
  /** The member's display name, resolved from the signed name store; non-empty
   *  only when `name_state` is `verified`. Mirrors the Rust `RosterMemberView`
   *  field of the same name. */
  display_name: string;
  /** `verified` | `unverified` | `absent`: whether the signed name store holds a
   *  record for this row and whether it verified. Not a flag, so "no name chosen"
   *  stays distinct from "a record nobody's signature backs". */
  name_state: "verified" | "unverified" | "absent";
  role: "owner" | "member";
  previous_fingerprint_hex: string | null;
  /** `current` | `changed` | `owner-confirmed`, or `null` on a legacy roster. */
  continuity: "current" | "changed" | "owner-confirmed" | null;
}

export interface RosterListView {
  members: RosterMemberView[];
  authority: "owner" | "member";
  /** The current group-key epoch on an `NTV6` vault; `null` for a legacy roster. */
  group_key_epoch: number | null;
}

export interface MembersHook {
  members: RosterMemberView[];
  authority: "owner" | "member";
  groupKeyEpoch: number | null;
  error: string | null;
}

/**
 * Read the unlocked vault's roster once.
 *
 * A plain binding rather than a hook, because there are two callers with different
 * lifetimes: [`useMembers`] below re-reads once per mount for the Members panel, and
 * the onboarding name step (`app/flows/IdentityFlow.tsx`, myne-md/myne#851 task 15)
 * reads it ONCE to decide whether it has to ask at all. It is the same IPC either
 * way, so it lives in one place, and `scripts/check-ipc-binding-callers.mjs` refuses
 * an exported binding with no production caller, which an inline `invoke` inside a
 * hook would hide.
 */
export function listRoster(): Promise<RosterListView> {
  return invoke<RosterListView>("plugin:sync|sync_list_roster");
}

/**
 * Read the unlocked vault's member roster + the caller's authority. Read-only on
 * mobile: the invite and removal flows need the person-identity prompt, which is
 * desktop-first until the member wire lands, and a member is never shown an
 * owner-only control here.
 */
export function useMembers(): MembersHook {
  const [members, setMembers] = useState<RosterMemberView[]>([]);
  const [authority, setAuthority] = useState<"owner" | "member">("member");
  const [groupKeyEpoch, setGroupKeyEpoch] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listRoster()
      .then((view) => {
        if (!cancelled) {
          setMembers(view.members);
          setAuthority(view.authority);
          setGroupKeyEpoch(view.group_key_epoch);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setMembers([]);
          setAuthority("member");
          setGroupKeyEpoch(null);
          setError(errKind(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { members, authority, groupKeyEpoch, error };
}
