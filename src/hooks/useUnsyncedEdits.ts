// `useUnsyncedEdits` — which notes the server has NOT acknowledged
// (phase3-web-client task 23).
//
// # Why this is not part of `useSyncStatus`
//
// `useSyncStatus` answers "is this device syncing" — one dot for the whole
// client. This answers "is *this note* safe", and the two disagree in exactly
// the case that matters: a device sitting at `idle` holding three notes the
// server has never seen, because the last cycle failed, or the tab has been
// offline, or the device is still awaiting approval. One green dot is a truthful
// summary of the connection and a false statement about the notes.
//
// # Where the answer comes from, and why it survives a reload
//
// `plugin:sync|sync_unsynced_edits` derives it from disk every time — each
// note's `MY01` header nonce against the `sync-state.json` baselines — so there
// is no in-RAM dirty flag to lose across a reload, and no optimistic local state
// that could clear the marker before the server actually acknowledged anything.
// The command is decryption-free, which is what makes polling it affordable.
//
// # Cadence
//
// Polled on the same 5 s beat as the status indicator, plus an immediate re-read
// on the engine's own `sync://status-changed` nudge — a completed cycle is
// exactly when the answer changes, and waiting a whole interval after a push
// would leave the marker lit on a note that is already safe.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../platform/core";
import { subscribeToEvents } from "../lib/subscribe";

/** Mirrors the Rust `UnsyncedEdits`. */
export interface UnsyncedEdits {
  /** Canonical UUIDs of notes whose current bytes the server has not seen. */
  note_ids: string[];
  /**
   * `false` when no endpoint is configured — the client makes no sync promise,
   * so an empty list is not an assurance. Kept distinct from an empty list with
   * `tracking: true`, which is one.
   */
  tracking: boolean;
  /** A credential change this device made that the server has not acknowledged
   *  (task 88). Derived from disk on every read, so it survives a reload. */
  credential_pending: boolean;
}

/** Poll cadence (ms) — matched to `useSyncStatus` so the two never disagree by
 *  more than one tick. */
const POLL_MS = 5000;

export interface UnsyncedEditsHook {
  /** Note ids to mark. Empty when nothing is pending OR when sync is off — use
   *  `tracking` to tell those apart. */
  unsyncedIds: Set<string>;
  /** Whether this client is making a sync promise at all. */
  tracking: boolean;
  /**
   * A password change made on this device that the server has not
   * acknowledged.
   *
   * Kept separate from `unsyncedIds` rather than folded into the same count
   * because the two are not the same kind of risk and must not be summarised
   * together. An unsynced note is still readable here and will still be here
   * after a sync. An unacknowledged credential change means this browser and
   * every other device disagree about what the account password IS — and on
   * web, where the local copy is an evictable cache and there is no recovery
   * phrase, clearing that cache loses the change with no way back.
   */
  credentialPending: boolean;
  /** Force a re-read (e.g. right after a save completes). */
  refresh: () => void;
}

/**
 * The unlit answer, used before the first read resolves and after any failure.
 *
 * A read failure leaves the previous answer standing rather than clearing it:
 * clearing would say "everything is safe" on the strength of a call that did not
 * come back, which is the one thing this hook must never do.
 */
const EMPTY: ReadonlySet<string> = new Set<string>();

export function useUnsyncedEdits(): UnsyncedEditsHook {
  const [unsyncedIds, setUnsyncedIds] = useState<Set<string>>(
    EMPTY as Set<string>,
  );
  const [tracking, setTracking] = useState(false);
  const [credentialPending, setCredentialPending] = useState(false);
  const mounted = useRef(true);
  // Held in a ref so `tick` stays referentially stable — it is wired into an
  // interval and two event listeners, and re-creating it would re-subscribe on
  // every poll.
  const lastKey = useRef<string>("");

  const tick = useCallback(() => {
    invoke<UnsyncedEdits>("plugin:sync|sync_unsynced_edits")
      .then((r) => {
        if (!mounted.current) return;
        setTracking(r.tracking);
        // Not gated behind the `lastKey` short-circuit below: that key is the
        // note list, and a credential change that lands (or clears) without the
        // note list moving would otherwise not reach the UI until some unrelated
        // note changed. React bails out of a no-op `setState` itself, so the
        // common case still costs no render.
        setCredentialPending(r.credential_pending === true);
        // The command returns a sorted list, so joining is a stable identity for
        // "the same answer" — this skips the state write (and the sidebar
        // re-render) on the overwhelmingly common no-change poll.
        const key = r.note_ids.join(",");
        if (key === lastKey.current) return;
        lastKey.current = key;
        setUnsyncedIds(new Set(r.note_ids));
      })
      .catch(() => {
        /* Keep the last-known answer. A transient IPC failure is not evidence
           that an edit reached the server. */
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    tick();
    const timer = setInterval(tick, POLL_MS);
    // A completed cycle is when this answer changes; the engine already emits a
    // nudge for the status dot, and the marker rides the same one. If the
    // subscription fails the poll above still carries the marker, one interval
    // later — see `subscribeToEvents`.
    const unsubscribe = subscribeToEvents(
      ["sync://status-changed", "sync://enrollment-changed"],
      tick,
    );
    return () => {
      mounted.current = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, [tick]);

  return { unsyncedIds, tracking, credentialPending, refresh: tick };
}
