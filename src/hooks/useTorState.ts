// `useTorState` — the live Tor routing posture (MYND-650 task 8).
//
// The preference and the posture are two different questions and this hook
// answers the second one: not "did the user turn Tor on" but "is sync going
// through a working Tor client right now". They come apart in the case that
// matters most — a sidecar that failed to start leaves the preference on and
// the tunnel down — and the surfaces this hook feeds (the fail-closed banner in
// the editor chrome, the Network panel's indicator) exist precisely for that
// gap.
//
// ## One poll, shared
//
// The state lives at module level rather than per-component, because the two
// consumers are mounted at once and must agree: the banner and the panel are
// two views of one fact, and two independent polls would show two different
// answers for up to a poll interval — including the interval right after the
// user flips the toggle, which is the moment they are watching. A shared cell
// also means `refresh()` from the panel updates the banner, and that the cost
// is one IPC per tick no matter how many surfaces read it.
//
// ## Why polling, and why two cadences
//
// The sidecar publishes its phase into the routing gate from a background
// thread in the host (`src-tauri/src/tor_sidecar/supervisor.rs`); there is no
// Tauri event for it today, so this reads. That is the same shape
// `useSyncStatus` uses, for the same reason. With Tor mode off the read is two
// `Copy` fields behind an `RwLock` and touches no file; with Tor mode on it also
// reads the small device-local endpoint config, because `exempt` is a property
// of the endpoint rather than of the process gate. Both are cheap, and the
// cadences below are set against the expensive one.
//
// The cadence follows the posture rather than being a single number:
//
//  - Tor mode ON: the phase moves on its own (bootstrap takes 5–30 s, a dead
//    process is observed by the reaper), and each move changes what the user is
//    being told about whether their traffic is protected. A slow poll there
//    would leave "connecting…" on screen after the tunnel came up, or leave
//    nothing on screen while sync was silently paused.
//  - Tor mode OFF (and the Tor-exempt loopback endpoint, which no phase change
//    can affect): nothing can change it but a deliberate act in this same app,
//    and every one of those paths re-reads. That is TWO inputs, not one, and
//    the second was missed when `exempt` was added: the toggle (which calls
//    `refresh()`) and the sync endpoint (`sync_set_endpoint` /
//    `sync_join_account`, whose screens call `refreshTorState()` — see
//    `EndpointConfig.tsx` and `JoinDeviceModal.tsx`). Without that second call
//    a user who repointed a loopback endpoint at a remote server kept reading
//    "this address points at this device", with the fail-closed banner
//    suppressed, until the slow tick came round. The slow tick is a backstop,
//    not a watch — so anything that can move `exempt` owes a `refreshTorState()`
//    on the path that moves it.
//
// Absent the `torRouting` capability (the web client) nothing is invoked at all
// and the posture stays `null`. A browser tab cannot know whether the browser
// around it is Tor Browser, and a confident "not protected" would be worse than
// no answer.

import { useCallback, useEffect, useState } from "react";

import { has } from "../platform/capabilities";
import { getTorState, torPosture, type TorPosture } from "../lib/tor-routing";

/** Poll interval while Tor mode is on — the phase moves without us. */
const ACTIVE_POLL_MS = 2000;
/** Poll interval while Tor mode is off — a backstop, not a watch. */
const IDLE_POLL_MS = 15000;

type Listener = (posture: TorPosture | null) => void;

const listeners = new Set<Listener>();
let current: TorPosture | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function publish(next: TorPosture | null) {
  current = next;
  for (const listener of listeners) listener(next);
}

function schedule(delay: number) {
  clearTimeout(timer);
  // No subscribers left → no timer. The posture is only worth knowing while
  // something is rendering it.
  if (listeners.size === 0) return;
  timer = setTimeout(tick, delay);
}

function tick() {
  getTorState()
    .then((view) => {
      const next = torPosture(view);
      publish(next);
      // `exempt` joins `inactive` on the slow tick: the sidecar's phase may
      // still be moving underneath, but none of its moves change what this
      // endpoint's traffic is doing, so there is nothing to watch for.
      const settled = next === "inactive" || next === "exempt";
      schedule(settled ? IDLE_POLL_MS : ACTIVE_POLL_MS);
    })
    .catch(() => {
      // Keep the last known posture rather than inventing one. A dropped read
      // says nothing about the tunnel, and flipping to "unavailable" would
      // raise a fail-closed warning over an IPC hiccup — which is how a warning
      // that means something becomes one users dismiss.
      schedule(ACTIVE_POLL_MS);
    });
}

/**
 * Re-read now, from outside React. The toggle calls this the moment it knows
 * the backend moved, so the banner and the indicator do not lag a tick behind
 * the click that caused them.
 */
export function refreshTorState() {
  if (!has("torRouting") || listeners.size === 0) return;
  tick();
}

export interface TorStateHook {
  /**
   * The current posture, or `null` before the first read resolves — and
   * always, on a platform without the capability. `null` means "we do not
   * know", and every consumer renders nothing rather than guessing.
   */
  posture: TorPosture | null;
  /** Re-read now. */
  refresh: () => void;
}

export function useTorState(): TorStateHook {
  const supported = has("torRouting");
  const [posture, setPosture] = useState<TorPosture | null>(supported ? current : null);

  useEffect(() => {
    if (!supported) return;
    const listener: Listener = setPosture;
    listeners.add(listener);
    // First subscriber starts the chain; later ones join the one already
    // running and get the cached value above until its next tick.
    if (listeners.size === 1) tick();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        clearTimeout(timer);
        timer = undefined;
        // Forget rather than keep: nothing is watching, so the next mount must
        // re-read instead of rendering a posture that aged in the dark.
        current = null;
      }
    };
  }, [supported]);

  const refresh = useCallback(() => refreshTorState(), []);

  return { posture, refresh };
}
