// Tauri IPC wrappers for the `clipper-pairing` plugin
// (ext-foundation-handoff task 4, TB10).
//
// The browser-extension pairing handshake's WebView side: read the pending
// pairing session (the numeric challenge to compare against the extension),
// then Accept (mint a scoped revocable token bound to the exact extension id)
// or Reject (clear the session, no lingering authorization).
//
// These are narrow, named-permission commands (`clipper-pairing:default` in
// capabilities/default.json) — the stdio native-messaging host is a SEPARATE,
// capability-ACL-exempt ingress; these three are ordinary WebView→Rust IPC.
//
// Signature parity (no codegen — see src/CLAUDE.md "Tauri command bindings"):
// keep these in step with `plugins::clipper_pairing::commands`.

import { invoke } from "@tauri-apps/api/core";

/** Mirrors `plugins::clipper_pairing::commands::PendingPairingView`. */
export interface PendingPairing {
  /** The exact extension id requesting the connection. */
  extension_id: string;
  /** The zero-padded numeric challenge the user compares to the extension. */
  challenge: string;
}

/** Mirrors `plugins::clipper_pairing::error::PairingError` (closed `kind`). */
export type PairingError =
  | { kind: "NoPendingPairing" }
  | { kind: "CsprngUnavailable" };

/**
 * Read the current pending pairing session, or `null` when no extension is
 * requesting a connection (the dialog stays unmounted).
 */
export async function pairingPending(): Promise<PendingPairing | null> {
  return (await invoke<PendingPairing | null>("plugin:clipper-pairing|pairing_pending")) ?? null;
}

/**
 * Accept the pending pairing — mints a scoped, revocable token bound to the
 * exact extension id and clears the session. Resolves to the token's bearer
 * value (the extension's copy, relayed by the host in the full flow).
 */
export async function pairingAccept(): Promise<string> {
  return invoke<string>("plugin:clipper-pairing|pairing_accept");
}

/**
 * Reject the pending pairing — clears the session WITHOUT minting a token
 * (no lingering authorization).
 */
export async function pairingReject(): Promise<void> {
  await invoke("plugin:clipper-pairing|pairing_reject");
}
