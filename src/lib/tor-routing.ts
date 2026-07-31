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

// ── the live posture (MYND-650 task 8) ──────────────────────────────────────

/**
 * Mirrors `myne_core::plugins::sync::proxy::TorProxyState` — the bundled Tor
 * client's phase, as the routing gate has it.
 *
 * The Rust `ready` variant also carries a `socksPort`, and this type omits it
 * because nothing in the UI has any use for a loopback port number. That is a
 * narrowing of the *declared* contract, not a runtime guarantee: the backend
 * returns its value verbatim, so the field is present on the wire and a
 * `JSON.stringify` of the view would still show it. What the omission buys is
 * that no component can reach it through the type — which is the point, since
 * the port names a listener on this device rather than anything secret.
 */
export type TorProxyState =
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "failed" }
  | { kind: "stopped" };

/** Mirrors `plugins::sync::tor::TorStateView`. */
export interface TorStateView {
  /** Tor mode as the sync routing gate has it. */
  enabled: boolean;
  /** The sidecar's phase. */
  state: TorProxyState;
  /**
   * The configured endpoint is exempt from Tor routing (it names this device),
   * so nothing is tunneled regardless of {@link enabled}. `false` when no
   * endpoint is configured.
   */
  exempt: boolean;
}

/**
 * What the user is actually getting right now.
 *
 * Five values, because the ones that matter most are indistinguishable from any
 * single field: `stopped` means "nothing is running", which is the ordinary
 * resting state when Tor mode is off and the fail-closed state when it is on.
 *
 * - `inactive` — Tor mode is off. Sync goes directly to the server, as it
 *   always has. Not a problem, and must never be dressed as one.
 * - `connecting` — Tor mode is on, the client is bootstrapping. Sync is
 *   **paused**; nothing is being sent directly in the meantime.
 * - `active` — Tor mode is on and the tunnel is up. The one state that may
 *   read as protected.
 * - `unavailable` — Tor mode is on and the tunnel is not usable (the client
 *   failed, timed out, died, or was never started). Sync is **paused**,
 *   fail-closed. This is the state that must be unmistakable.
 * - `exempt` — Tor mode is on, but the configured endpoint names this device,
 *   so no circuit is involved and sync is **not** paused. Its own posture
 *   rather than `active` (which would claim a tunnel that does not exist) and
 *   rather than `inactive` (which would look like the toggle did not take).
 */
export type TorPosture = "inactive" | "connecting" | "active" | "unavailable" | "exempt";

/**
 * Derive the posture from the backend view.
 *
 * This is deliberately the same decision `ProxyGate::route()` makes in Rust,
 * in the same order: `enabled` is checked first, so a stale `ready` left over
 * from before the user turned Tor off can never render as "active" — exactly
 * as it can never produce a SOCKS route. Any other mapping would put the UI and
 * the transport in disagreement about whether traffic is tunneled, and the UI
 * would be the one lying.
 *
 * `exempt` is checked second, and before the phase, for the same reason: the
 * transport hands a loopback endpoint a direct-only gate no matter what the
 * process gate says, so a `ready` sidecar tunnels nothing there. Reading the
 * phase first would render "active" over traffic that never enters a circuit.
 */
export function torPosture(view: TorStateView): TorPosture {
  if (!view.enabled) return "inactive";
  if (view.exempt) return "exempt";
  switch (view.state.kind) {
    case "ready":
      return "active";
    case "starting":
      return "connecting";
    // `failed` and `stopped` are one posture on purpose. They differ in how the
    // sidecar got there, not in what the user is getting — which is a paused
    // sync and no direct connection — and a UI that split them would be
    // reporting our process bookkeeping rather than their situation.
    case "failed":
    case "stopped":
      return "unavailable";
  }
}

/**
 * Read the live posture. Infallible on the Rust side, and deliberately separate
 * from {@link getTorRouting}: that one reports the preference the user set, this
 * one reports what the transport is obeying. They disagree exactly when it
 * matters — a sidecar that failed to start leaves the preference on and the
 * tunnel down.
 *
 * Cheap, with one qualification worth knowing before you poll it faster: with
 * Tor mode off it reads an in-memory cell and nothing else, and with Tor mode on
 * it also reads the device-local endpoint config to fill {@link
 * TorStateView.exempt}.
 */
export async function getTorState(): Promise<TorStateView> {
  return await invoke<TorStateView>("plugin:sync|sync_get_tor_state");
}
