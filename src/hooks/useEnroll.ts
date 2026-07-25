// `useEnroll` — the add-device enrollment action (MYND-425 task 5). Wraps the
// `sync` plugin's `sync_enroll` command, which fetches `vault.meta` pre-auth,
// derives root_key from {account# + password/phrase}, derives the ServerAuth
// secret, runs the SCRAM enrollment handshake, and (on approval) stores the
// device-local token.
//
// The credential never lands in React state beyond the controlled inputs the
// caller owns; this hook takes it per-call and hands it straight to IPC.

import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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

/** A serialized `SyncDeviceError` from the plugin. */
interface SyncDeviceError {
  kind: string;
}

/** The terminal outcome surfaced to the form. `approved` = token issued and
 *  syncing; `pending` = held by the approval gate; `error` = a non-secret
 *  failure kind the form maps to honest, non-distinguishing copy. */
export type EnrollOutcome =
  | { state: "approved" }
  | { state: "pending" }
  | { state: "error"; kind: string };

function errKind(e: unknown): string {
  if (e && typeof e === "object" && "kind" in e) {
    return (e as SyncDeviceError).kind;
  }
  return "Internal";
}

export interface EnrollHook {
  /** Whether an enrollment attempt is in flight. */
  busy: boolean;
  /** The last terminal outcome, or null before the first attempt. */
  outcome: EnrollOutcome | null;
  /** Run an enrollment attempt. The credential is passed straight to IPC.
   *  `deviceName` (MYND-548) goes to the CORE, which parks it in device-local
   *  sync state and applies it in a later prefs phase. It must not be written to
   *  `vault.prefs` here: creating that blob before the first authed cycle
   *  permanently disables the §10.2.1 enrollment wholesale seed. */
  enroll: (
    accountNumber: string,
    credential: string,
    credentialKind: EnrollCredentialKind,
    deviceName: string,
  ) => Promise<void>;
  /** Clear the last outcome (e.g. when the user edits the form to retry). */
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
          deviceName,
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
