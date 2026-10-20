// The mobile awareness consumer: the supervisor's presence frames into the shared
// store, and the store's peers for the open note into the shared editor's
// `awareness` prop.
//
// # What is shared and what is not
//
// The store, the label rule and the decoration field are SHARED, not reimplemented.
// `@myne/awareness-store` is the module-scope state machine the desktop pane drives
// (`src/notes/collab/awarenessStore.ts`), and `@myne/editor` already holds the
// decoration field and its `awareness` prop, so this file is WIRING: subscribe,
// write, project. A mobile-only copy of the store would be a second place the
// per-note keying and the drop grace window could drift, and the decoration field
// is already the same code on both clients.
//
// # Why the frames need no self-filter here
//
// A presence frame the relay fans back to its publisher is dropped in RUST, not on
// the client: `AwarenessRoute::SelfEcho` (`core/src/plugins/live/awareness.rs`) is
// counted and discarded before any event is emitted, and
// `a_devices_own_presence_frame_is_dropped_as_self_echo` pins it
// (`core/src/plugins/live/awareness_test.rs`). Re-filtering here would be a second
// place for that decision, and the client has no reliable way to know its own actor
// anyway.
//
// # The drop is a grace window, not an immediate clear
//
// A dropped stream starts the same `AWARENESS_GRACE_MS` window desktop uses, and the
// peers survive it so a reconnect does not flicker every caret away. A frame arriving
// during the window cancels it (the store clears `droppedAt` on upsert).
//
// # No clear on unmount
//
// The store is MODULE-scope and outlives the screen, so an unmount clear would be
// indistinguishable from a lock clear and would drop peers a surviving surface is
// still rendering. The vault-leaving paths call `clearAwareness()` themselves, and
// `scripts/check-frontend-lock-teardown.mjs` holds each of them to it.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  AWARENESS_GRACE_MS,
  awarenessNotePeers,
  awarenessOnDrop,
  awarenessSweep,
  awarenessUpsert,
  getAwarenessSnapshot,
  setAwareness,
  subscribeAwareness,
  type PresenceUpdate,
} from "@myne/awareness-store";
import { colorVarForIndex } from "@myne/participant";
import type { Participant } from "@myne/participant";
import { resolvePeerLabels } from "@myne/presence-labels";
import { resolveIdentity } from "./identity";
import { identityLabelText } from "@myne/identity-label";
import type { AwarenessPush } from "@myne/editor/decorations/awareness";
import { listen, type UnlistenFn } from "../platform/event";

/** The presence event the supervisor emits per routed peer frame. */
const PRESENCE_EVENT = "sync://awareness";
/** The stream-dropped event. Peers clear only if the stream does not return. */
const DROPPED_EVENT = "sync://awareness-dropped";

/**
 * Subscribe the shared store to the supervisor's presence events. Returns the
 * disposer; call it once per mounted editor screen.
 *
 * Both `listen` registrations resolve on a promise, so the disposer may run before
 * they land (a screen unmounted inside the same tick). Each `.then` checks the flag
 * and unlistens immediately in that case, which is the same guard the desktop pane
 * carries and exists because a leaked listener keeps writing into a module-scope
 * store nobody is rendering.
 */
export function installAwarenessChannel(): () => void {
  let disposed = false;
  let unlistenUpdate: UnlistenFn | null = null;
  let unlistenDrop: UnlistenFn | null = null;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;

  void listen<PresenceUpdate>(PRESENCE_EVENT, (event) => {
    if (disposed) return;
    setAwareness((s) => awarenessUpsert(s, event.payload));
  }).then((fn) => {
    if (disposed) fn();
    else unlistenUpdate = fn;
  });

  void listen(DROPPED_EVENT, () => {
    if (disposed) return;
    setAwareness((s) => awarenessOnDrop(s, Date.now()));
    if (sweepTimer !== null) clearTimeout(sweepTimer);
    sweepTimer = setTimeout(() => {
      setAwareness((s) => awarenessSweep(s, Date.now()));
    }, AWARENESS_GRACE_MS);
  }).then((fn) => {
    if (disposed) fn();
    else unlistenDrop = fn;
  });

  return () => {
    disposed = true;
    if (unlistenUpdate !== null) unlistenUpdate();
    if (unlistenDrop !== null) unlistenDrop();
    if (sweepTimer !== null) clearTimeout(sweepTimer);
  };
}

/** Install the awareness channel for as long as the calling screen is mounted. */
export function useAwarenessChannel(): void {
  useEffect(() => installAwarenessChannel(), []);
}

/**
 * The shared store, subscribed. Every surface reading awareness goes through this,
 * so the roster (task 6) and the decoration field (below) cannot disagree about what
 * is in it.
 */
function useAwarenessState() {
  return useSyncExternalStore(subscribeAwareness, getAwarenessSnapshot);
}

/**
 * The peers editing `noteId`, from the shared store.
 *
 * The roster sheet (task 6) and the top bar's presence chip both read through
 * this, so the count that decides whether the affordance appears and the list the
 * affordance opens cannot disagree. Empty for `null`, which is the no-note case
 * rather than an empty note.
 */
export function useAwarenessPeers(noteId: string | null): readonly Participant[] {
  const awareness = useAwarenessState();
  return useMemo(
    () => (noteId === null ? EMPTY_PEERS : [...awarenessNotePeers(awareness, noteId).values()]),
    [awareness, noteId],
  );
}

/** One stable empty list, so a no-note render does not churn a dependency. */
const EMPTY_PEERS: readonly Participant[] = Object.freeze([]);

/**
 * Resolve every un-attributed peer's label through the backend identity resolver
 * (`myne-md/myne#849` task 7).
 *
 * This is the mobile half of the label rule. The RULE is shared, not reimplemented:
 * `resolvePeerLabels` owns the loop and writes the DESCRIPTOR into the store, and
 * `identityLabelText` renders it at each surface's own render. What is injected here
 * is this client's binding for the same shared-core command the desktop pane passes,
 * which is why a peer resolves to the same name on both clients.
 *
 * A peer the resolver answers `Unknown` for stays un-attributed on purpose, and that
 * is a security property rather than an omission: the roster renders its own degraded
 * copy for that case, so a row can never be presented as evidence of authorship
 * (`decisions/protocol/0669`, which the shared module's own comment cites).
 *
 * A rejection leaves the peer un-attributed for the next frame to retry, which is why
 * nothing is rethrown: `resolvePeerLabels` swallows it and a resolver hiccup must not
 * take the editor down.
 */
export function useAwarenessLabelResolution(noteId: string | null): void {
  const awareness = useAwarenessState();
  useEffect(() => {
    if (noteId === null) return;
    void resolvePeerLabels(awarenessNotePeers(awareness, noteId).values(), resolveIdentity);
  }, [awareness, noteId]);
}

/**
 * The `awareness` prop for the shared editor, bound to `noteId`.
 *
 * `undefined` means THIS HOST DOES NOT DRIVE AWARENESS, which the editor reads as
 * "push nothing" rather than "clear". It is returned for a `null` note (no note on
 * screen), which also keeps the push identity stable across renders where nothing
 * arrived, so the editor's `setAwareness` effect does not fire per keystroke.
 *
 * The peer shape is projected here rather than in the editor because colour is the
 * app's (`Participant` holds the index, the palette name never crosses the engine
 * boundary) and the label is a translator's: a peer with no resolved label renders
 * the empty string, and the shared rule renders the degraded device form once the
 * resolver has answered (`presenceLabels.ts`).
 */
export function useAwarenessForNote(noteId: string | null): AwarenessPush | undefined {
  const awareness = useAwarenessState();
  const { t, i18n } = useTranslation();
  return useMemo(
    () =>
      noteId !== null
        ? {
            noteId,
            peers: [...awarenessNotePeers(awareness, noteId).values()].map((p) => ({
              ...p,
              label: p.label === null ? "" : identityLabelText(p.label, t),
              colorVar: colorVarForIndex(p.color),
            })),
          }
        : undefined,
    // `i18n.language` is a dependency because `t` is stable across a language
    // switch: without it a peer listed before the switch keeps the old language's
    // degraded copy, which is the desktop pane's own comment one file over.
    [awareness, noteId, t, i18n.language],
  );
}
