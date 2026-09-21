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
  | "Render";

/**
 * Build a device-join QR from the user-pasted account number.
 *
 * Option 1 (prompt-to-paste): the account number is an AS9 bearer token Myne
 * never persists at rest (`account-number.md §8`), so the caller supplies it from
 * the user's own saved copy — it is never read from storage. The QR carries
 * `{server_url, account#, cert_pin}` and NEVER the password (SYNC-47).
 */
export async function generateDeviceJoinQr(
  accountNumber: string,
): Promise<DeviceJoinQr> {
  return invoke<DeviceJoinQr>("plugin:sync|sync_device_join_qr", {
    accountNumber,
  });
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
