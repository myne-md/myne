// TS binding for the desktop device-join QR command (MYND-466).
// Mirrors `sync::qr::sync_device_join_qr` (src-tauri/src/plugins/sync/qr.rs).
// No mock layer — real Tauri command (see src/AGENTS.md "Tauri command bindings").

import { invoke } from "../platform/core";
import i18n from "../i18n";

/** Mirror of Rust `sync::qr::DeviceJoinQr`. */
export interface DeviceJoinQr {
  /** A self-contained SVG string rendering the join payload as a QR. */
  svg: string;
  /** Seconds the payload stays fresh — regenerate before this lapses. */
  ttl_secs: number;
}

/** Mirror of Rust `sync::qr::DeviceJoinQrError` `kind` tags. */
export type DeviceJoinQrErrorKind =
  | "NotConfigured"
  | "InvalidAccountNumber"
  | "EndpointRead"
  | "Render"
  | "NotAMemberVault"
  | "VaultAccountUnknown";

/**
 * Build a device-join QR from the user-pasted account number.
 *
 * Option 1 (prompt-to-paste): the account number is an AS9 bearer token Myne
 * never persists at rest (`account-number.md §8`), so the caller supplies it from
 * the user's own saved copy — it is never read from storage. The QR carries
 * `{server_url, account#}` and NEVER the password (SYNC-47).
 */
export async function generateDeviceJoinQr(
  accountNumber: string,
): Promise<DeviceJoinQr> {
  return invoke<DeviceJoinQr>("plugin:sync|sync_device_join_qr", {
    accountNumber,
  });
}

/**
 * Build the QR that brings **another device of the same person** into the shared
 * vault this device is a member of (myne-md/myne).
 *
 * Takes no argument on purpose: the vault is resolved from the active session
 * backend-side, so this cannot describe a vault the caller is not in. The payload
 * carries the server address and the vault's account hash — never the recovery
 * phrase, which the scanning device is asked for and which never leaves a device.
 *
 * Refuses (`NotAMemberVault`) on any session that is not a member of a shared
 * vault: an owner's second device joins with the account number + password.
 */
export async function generateMemberJoinQr(): Promise<DeviceJoinQr> {
  return invoke<DeviceJoinQr>("plugin:sync|sync_member_join_qr");
}

/** Map a `sync_device_join_qr` failure to its user-facing message (the repo's
 *  `src/lib/*-errors.ts` convention: read the serialized `kind`, resolve via i18n). */
export function deviceJoinQrErrorMessage(e: unknown): string {
  const kind =
    e && typeof e === "object" && "kind" in e
      ? (e as { kind?: DeviceJoinQrErrorKind }).kind
      : undefined;
  switch (kind) {
    case "InvalidAccountNumber":
      return i18n.t("sync.deviceJoinQr.invalidAccount");
    case "NotConfigured":
      return i18n.t("sync.deviceJoinQr.notConfigured");
    default:
      return i18n.t("sync.deviceJoinQr.error");
  }
}

/** Map a `sync_member_join_qr` failure to its user-facing message. Separated from
 *  the account mapper because the two commands share an error ENUM but not a
 *  remedy: `NotAMemberVault` has no account-plane equivalent, and the account
 *  number the sibling names does not exist on this path.
 *
 *  `VaultAccountUnknown` gets its own sentence rather than the generic retry: the
 *  member variant has NO retry control (the Generate button belongs to the account
 *  variant, and this one mints on mount), so a sentence saying "try again" would
 *  name an action the surface does not offer. What it says instead is the one thing
 *  the user can actually do about it. */
export function memberJoinQrErrorMessage(e: unknown): string {
  const kind =
    e && typeof e === "object" && "kind" in e
      ? (e as { kind?: DeviceJoinQrErrorKind }).kind
      : undefined;
  switch (kind) {
    case "NotAMemberVault":
      return i18n.t("sync.memberJoinQr.notAMember");
    case "NotConfigured":
      return i18n.t("sync.memberJoinQr.notConfigured");
    case "VaultAccountUnknown":
      return i18n.t("sync.memberJoinQr.noAccount");
    default:
      return i18n.t("sync.memberJoinQr.error");
  }
}
