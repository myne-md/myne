// Tauri IPC wrapper for the device-local Tor-routing toggle (MYND-650 task 6).
//
// One boolean, and it is deliberately NOT in `prefs.ts`. Everything that module
// carries is a field of the encrypted `vault.prefs` (`MYP1`) blob, which syncs
// to every device on the account; this setting must not. Network posture is a
// property of the machine — the same vault is legitimately opened from a laptop
// on a hostile network and a desktop at home — and syncing it would mean that
// turning Tor on in one place silently makes another device refuse to sync
// (fail-closed) over a decision made somewhere the user was not. So it lives in
// its own device-local file and gets its own two commands.
//
// Signature parity (no codegen — see src/CLAUDE.md "Tauri command bindings"):
// keep this in step with `src-tauri/src/plugins/sync/tor.rs`.
//
// Desktop-only. The `torRouting` capability is absent on web — a page has no
// subprocess to spawn and no raw socket to tunnel — so the Developer Options
// block that reads this is omitted there, and the wasm dispatcher answers both
// commands with a typed refusal. Web users route the whole browser through Tor
// Browser instead (task 12).

import { invoke } from "../platform/core";

/** Mirrors `plugins::sync::tor::TorRoutingView`. */
export interface TorRoutingView {
  /** Whether sync egress is routed through the device-local Tor proxy. */
  enabled: boolean;
}

/**
 * Mirrors `plugins::sync::tor::TorRoutingError`'s `kind` tag.
 *
 * `SidecarStartFailed` is the one worth handling specially, and NOT as a plain
 * failure: the preference was saved and Tor mode is **on**: sync is paused
 * rather than routed directly. Copy for it must not read as "Tor is off".
 */
export type TorRoutingErrorKind = "Io" | "Parse" | "SidecarStartFailed";

/** Narrow an unknown thrown value to the backend error's `kind` tag. */
export function torRoutingErrorKind(e: unknown): TorRoutingErrorKind | null {
  const kind = (e as { kind?: unknown } | null)?.kind;
  return kind === "Io" || kind === "Parse" || kind === "SidecarStartFailed" ? kind : null;
}

/**
 * Read the toggle. Absent preference ⇒ `false`, which is every install that has
 * never opted in.
 */
export async function getTorRouting(): Promise<TorRoutingView> {
  return await invoke<TorRoutingView>("plugin:sync|sync_get_tor_routing");
}

/**
 * Flip the toggle. On resolve the preference is persisted, the sync transport's
 * routing gate matches it, and the Tor sidecar has been started or stopped.
 *
 * A rejection with `SidecarStartFailed` still means the preference is ON — the
 * backend deliberately does not roll it back, because dropping the user to
 * direct sync as a form of error recovery is the failure this feature exists to
 * prevent. Re-read with {@link getTorRouting} rather than assuming the toggle
 * bounced back.
 */
export async function setTorRouting(enabled: boolean): Promise<TorRoutingView> {
  return await invoke<TorRoutingView>("plugin:sync|sync_set_tor_routing", { enabled });
}
