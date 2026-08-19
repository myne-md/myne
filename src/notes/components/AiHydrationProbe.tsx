// `<AiHydrationProbe>` — a zero-chrome, test-only observability surface for the
// AI embedding-index hydrate outcome (MYND-453, ai-embeddings-persistence task
// 8). Subscribes to the backend `ai://vectors-hydrated` event (emitted once the
// detached embed-on-unlock walk settles) and reflects its bounded counters onto
// `data-*` attributes so the real-IPC E2E harness can distinguish a persistence
// HIT from a full REBUILD without reading a log.
//
// It renders nothing visible (a display:none marker). This is a SYNC-8
// `data-testid` observability hook — NOT a feature surface: the counters carry
// only totals + one boolean (never a note_id / vector / nonce — DENY-list
// clean), and the element is absent until the first hydrate event fires.
//
// The two E2E-load-bearing states (asserted by `ai-embeddings-persistence.e2e.ts`):
//   - persistence HIT   → data-loaded-from-blob="true",  data-reembedded="0"
//   - full REBUILD/cold → data-loaded-from-blob="false", data-reembedded>"0"
// (a model swap invalidates the model-identity tuple → fall-to-rebuild.)
//
// == WHY THE STATE IS MODULE-SCOPE AND THE LISTENER IS NEVER TORN DOWN ==
// This component mounts inside `src/screens/Editor.tsx`, which exists ONLY
// while a vault is unlocked. The whole scenario this probe was built for drives
// lock → re-unlock cycles, so the component unmounts and remounts between every
// hydrate it is supposed to observe. Holding the subscription and the counter in
// `useState` inside that lifecycle broke it in two independent ways, and both
// were invisible to every check in the repo:
//
//  1. **The event outran the subscription.** `unlock_from_host` spawns the walk
//     DETACHED and returns; the WebView then has to re-render the whole Editor
//     tree before this effect runs and its async `listen()` resolves. The walk
//     is a stub embed over one small note. Tauri's `emit` has no replay, so an
//     event that arrives inside that window is gone for good, and the scenario's
//     only report was a 30 s timeout that reads as a hung backend.
//  2. **The sequence counter restarted from zero.** The harness reads `data-seq`
//     BEFORE a lock and then waits for a strictly greater one after the
//     re-unlock. A `useState` counter resets on remount, so after the first
//     observed hydrate every subsequent leg waited for `seq > 1` while a fresh
//     probe kept re-reporting `seq === 1`. That leg could never pass, at any
//     timeout, on any machine.
//
// Hoisting both to module scope fixes both at once: the subscription is
// established on the FIRST Editor mount and never unsubscribes, so no event can
// land unheard afterwards, and `seq` is monotonic for the life of the page the
// way the harness always assumed. A remounted probe also renders the last
// outcome immediately instead of blanking, which is what makes reading `seq`
// before a lock meaningful at all.
//
// It is a one-time lazy subscribe rather than an import-time side effect so a
// module import stays inert; the trade is that the very first unlock of a
// session can still outrun it. That is deliberate and harmless here: the AI
// opt-in is off by default, so the walk on a first unlock returns before it can
// emit anything.

import { useCallback, useSyncExternalStore } from "react";
import { listen } from "../../platform/event";

/** Backend event name — mirror of `AI_VECTORS_HYDRATED_EVENT` (Rust,
 *  `src-tauri/src/plugins/local_inference/hydrate.rs`). */
const AI_VECTORS_HYDRATED_EVENT = "ai://vectors-hydrated";

/** Payload mirror of the Rust `AiVectorsHydrated` — bounded counters only. */
interface AiVectorsHydrated {
  embedded: number;
  loaded_from_blob: boolean;
  reembedded: number;
}

/** The last hydrate outcome plus a page-lifetime monotonic sequence number.
 *  `seq === 0` means no hydrate has been observed yet, which is why `last` is
 *  `null` in exactly that case. */
interface HydrationSnapshot {
  last: AiVectorsHydrated | null;
  seq: number;
}

/** Module-scope so it survives the Editor unmount a vault lock causes. Replaced
 *  wholesale per event, never mutated, so `useSyncExternalStore`'s identity
 *  comparison sees a change exactly when there is one. */
let snapshot: HydrationSnapshot = { last: null, seq: 0 };

const listeners = new Set<() => void>();

/** Subscribed once, on the first mount, and never unsubscribed — see the header.
 *  Lazy rather than an import-time side effect so importing this module does no
 *  IPC on its own. */
let subscribed = false;
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  void listen<AiVectorsHydrated>(AI_VECTORS_HYDRATED_EVENT, (e) => {
    snapshot = { last: e.payload, seq: snapshot.seq + 1 };
    for (const notify of listeners) notify();
  });
}

/** Test-only reset of the module state, so one spec's events cannot leak into
 *  the next. Never called by production code — a real session wants exactly the
 *  page-lifetime persistence this store exists to provide. */
export function __resetAiHydrationProbeForTests(): void {
  snapshot = { last: null, seq: 0 };
  listeners.clear();
  subscribed = false;
}

export function AiHydrationProbe() {
  const subscribe = useCallback((notify: () => void) => {
    ensureSubscribed();
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
    };
  }, []);
  const { last, seq } = useSyncExternalStore(subscribe, () => snapshot);

  if (last === null) return null;

  return (
    <div
      data-testid="ai.hydration-probe"
      data-embedded={String(last.embedded)}
      data-loaded-from-blob={last.loaded_from_blob ? "true" : "false"}
      data-reembedded={String(last.reembedded)}
      data-seq={String(seq)}
      style={{ display: "none" }}
    />
  );
}
