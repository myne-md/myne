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

import { invoke } from "../platform/core";

/** Mirrors `plugins::clipper_pairing::commands::PendingPairingView`. */
export interface PendingPairing {
  /** The exact extension id requesting the connection. */
  extension_id: string;
  /** The zero-padded numeric challenge the user compares to the extension. */
  challenge: string;
  /**
   * The relay correlation id when this session was opened by an incoming `pair`
   * handoff over the native-messaging relay (a relay thread is blocked waiting
   * for the Accept/Reject outcome under this id). `null` for a session not
   * opened by the relay. When present, the dialog MUST call
   * `pairingDispatchComplete` so the relay can reply the minted token back to
   * the extension.
   */
  request_id?: string | null;
}

/** The user's pairing decision the dialog reports back to the blocked relay. */
export type PairingDecision = "accepted" | "rejected";

/** Mirrors `plugins::clipper_pairing::error::PairingError` (closed `kind`). */
export type PairingError =
  | { kind: "NoPendingPairing" }
  | { kind: "CsprngUnavailable" }
  /**
   * The registry write to `vault.prefs` failed, so the pairing could not be
   * made durable (myne#290). The host ROLLS BACK the accept — the session is
   * restored under its original challenge and the minted token is dropped — so
   * a retry is non-destructive and there is still a session to re-poll.
   *
   * Two ways in, and the first is ordinary: the vault locked between the dialog
   * opening and the click (a Lock press, or idle auto-lock — nothing clears the
   * pending session on lock, so the card stays rendered and clickable over the
   * Unlock screen). The second is a genuine write failure on the vault volume.
   *
   * The union listed only two of the three kinds while claiming to be a closed
   * mirror, which is what let no consumer be forced to consider this one.
   */
  | { kind: "PersistFailed" };

/** Narrow an unknown rejection to a mirrored `PairingError` kind. */
export function pairingErrorKind(e: unknown): PairingError["kind"] | null {
  if (typeof e !== "object" || e === null) return null;
  const kind = (e as { kind?: unknown }).kind;
  return kind === "NoPendingPairing" || kind === "CsprngUnavailable" || kind === "PersistFailed"
    ? kind
    : null;
}

/**
 * Mirrors `clipper::install::InstallStatus` — the browser native-messaging host
 * install state surfaced to the Settings toggle. `installedBrowsers` are the
 * lowercase labels ("firefox" | "chrome" | "edge") whose manifest is present.
 */
export interface ClipperInstallStatus {
  /** Whether the host manifest is registered (the opt-in flag; absent ⇒ off). */
  enabled: boolean;
  /** The absolute path of the running host binary the manifest points at. */
  hostPath: string | null;
  /** Labels of the browsers currently carrying our manifest. */
  installedBrowsers: string[];
}

/** The Rust `InstallStatus` wire shape (snake_case) → the camelCase view above. */
interface InstallStatusWire {
  enabled: boolean;
  host_path: string | null;
  installed_browsers: string[];
}

function toInstallStatus(w: InstallStatusWire): ClipperInstallStatus {
  return {
    enabled: w.enabled,
    hostPath: w.host_path ?? null,
    installedBrowsers: w.installed_browsers ?? [],
  };
}

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

/**
 * Report the user's pairing decision back to the BLOCKED RELAY THREAD waiting
 * under `requestId` (the relay then replies the token — or a reject error — to
 * the extension over the native-messaging channel). Call this ONLY when the
 * pending session carried a `request_id` (i.e. it was opened by the relay).
 *
 * On `"accepted"` pass the token `pairingAccept` minted; the relay fails closed
 * (replies an error, never a fake pairing) if the token is missing/empty. On
 * `"rejected"` omit the token. Best-effort: a stale/no-pending id is a no-op
 * Rust-side (the relay may have already timed out) — never surfaces an error.
 */
export async function pairingDispatchComplete(
  requestId: string,
  outcome: PairingDecision,
  token?: string,
): Promise<void> {
  await invoke("plugin:clipper-pairing|pairing_dispatch_complete", {
    requestId,
    outcome,
    token: token ?? null,
  });
}

/**
 * One live (non-revoked) paired extension. Mirrors the Rust
 * `plugins::clipper_pairing::commands::PairedExtensionView` — the extension id
 * ONLY, never the token's bearer value (task 7, MYND-443). The connected-
 * extensions Settings section renders these and offers a per-row Revoke.
 */
export interface PairedExtension {
  /** The exact extension id that holds a live pairing token. */
  extensionId: string;
  /** Unix seconds when the pairing was issued (the Accept time), or `null` for a
   *  record from before this field existed. The "connected when" line; never a
   *  token value. */
  pairedAt: number | null;
}

/**
 * List the currently paired (live, non-revoked) browser extensions. Each entry
 * carries the extension id + its issue time — never a token value. Used by the
 * "Connected extensions" Settings section.
 */
export async function listPairedExtensions(): Promise<PairedExtension[]> {
  const rows =
    (await invoke<{ extension_id: string; paired_at: number | null }[]>(
      "plugin:clipper-pairing|pairing_list_paired",
    )) ?? [];
  return rows.map((r) => ({
    extensionId: r.extension_id,
    pairedAt: r.paired_at ?? null,
  }));
}

/**
 * Revoke a paired extension — desktop-authoritative, immediate + durable. The
 * extension must re-pair to reconnect (its side handles the re-pair prompt;
 * out of scope here). Tauri auto-converts the camelCase arg to the Rust
 * `extension_id` snake_case parameter.
 */
export async function revokePairedExtension(extensionId: string): Promise<void> {
  await invoke("plugin:clipper-pairing|pairing_revoke", { extensionId });
}

/**
 * Read the browser native-messaging host install status (the opt-in flag + the
 * resolved host binary path + which browsers currently carry the manifest). In a
 * non-Tauri context (dev) `invoke` rejects — treat that as "disabled/unknown".
 */
export async function getClipperInstallStatus(): Promise<ClipperInstallStatus> {
  const wire = await invoke<InstallStatusWire>("plugin:clipper-pairing|clipper_install_status");
  return toInstallStatus(wire);
}

/**
 * Register (`enabled = true`) or deregister (`false`) the browser clipper host:
 * writes the opt-in flag and reconciles the on-disk manifests immediately (no
 * restart). Resolves to the fresh status so the UI updates without a re-query.
 */
export async function setClipperInstallEnabled(
  enabled: boolean,
): Promise<ClipperInstallStatus> {
  const wire = await invoke<InstallStatusWire>(
    "plugin:clipper-pairing|clipper_install_set_enabled",
    { enabled },
  );
  return toInstallStatus(wire);
}
