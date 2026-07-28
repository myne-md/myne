// The stage ↔ history binding (phase3-web-client task 64).
//
// `src/platform/history.ts` answers "what can a URL address"; this module
// answers the harder half: **which app transitions deserve a history entry, and
// what a back press is allowed to do to a vault that is unlocked.**
//
// # Two owners, one URL
//
// [`useStageRoute`] owns the pre-unlock stages, [`useNoteRoute`] owns the
// editor. They never both write, because they never both apply: the stage hook
// deliberately skips `editor` (only the note binding knows which note is open,
// and a `/editor` write would drop the id a bookmark is made of), and the note
// hook only mounts inside the editor.
//
// # Push vs replace
//
// **Replace** the first location — the stage you boot into is where you already
// are, and recording it as a NEW entry would cost the user a back press to
// leave a screen they never navigated to. **Push** every transition after it,
// so back means "the screen before this one".
//
// # A back press is a REQUEST, not a command
//
// `Route` → `Stage` is lossy by construction: a stage carries mount-time
// payload (`initialStatus`, `suspicionReason`, `briefing`) that is session
// state and must never live in a URL. So a popstate does not RECONSTRUCT a
// stage. Between pre-unlock stages it calls `reprobe()` — the boot probe is the
// only honest answer to "where does this app actually belong", and it is
// already the door the create screen's own Back button uses.
//
// Out of the editor it does nothing at all. Back is not a lock affordance:
// honouring it would show a locked screen over a live unlocked slot, and
// FORWARD would then walk back in without a password. The note binding puts the
// address bar back where it was, which is the only visible effect.
//
// # The deep link, and why a reload is the normal case
//
// A browser client's keys live in RAM, so **every reload lands locked** —
// "restore my bookmarked note" and "resolve a deep link through unlock" are the
// same path, not an edge case. That is why nothing rewrites the URL while a
// deep-link note is unconsumed: the address bar holds the DESTINATION, the
// unlock screen is a gate in front of it, and a rewrite to `/unlock` would
// throw the destination away before the user could reach it.

import { useEffect, useRef } from "react";
import {
  onRouteChange,
  pushRoute,
  readRoute,
  replaceRoute,
  type RouteName,
} from "../platform/history";

// ── the boot deep link ──────────────────────────────────────────────────────
//
// Module state, because this models a genuinely global one-shot fact: the URL
// this page was opened at, which is read once and consumed once. Threading it
// as a prop would mean passing it from `App` through the whole Editor chrome to
// the one component that awaits `note_list` — the only place that can tell a
// live note id from a stale one.

let bootNoteId: string | null = null;
let bootRead = false;

function readBootOnce(): void {
  if (bootRead) return;
  bootRead = true;
  bootNoteId = readRoute()?.noteId ?? null;
}

/** True while the client was opened at a note that has not been resolved yet. */
export function deepLinkPending(): boolean {
  readBootOnce();
  return bootNoteId !== null;
}

/**
 * The note id this client was opened at, or `null`. Consuming, once.
 *
 * The caller MUST check the id against the live note list before opening it: a
 * URL is untrusted input, and a bookmark outlives the note it points at. An id
 * that is not in the list is dropped — the user lands in the editor with
 * nothing open, never on an error screen.
 */
export function takeDeepLinkNoteId(): string | null {
  readBootOnce();
  const id = bootNoteId;
  bootNoteId = null;
  return id;
}

/** @internal Test-only reset of the one-shot boot read. */
export function __resetRoutingForTest(): void {
  bootRead = false;
  bootNoteId = null;
}

// ── the bindings ────────────────────────────────────────────────────────────

/**
 * Bind the app's stage to the address bar.
 *
 * `stageName` is `null` while the boot probe is in flight (nothing is recorded
 * — the app is not anywhere yet). `reprobe` is `App`'s existing "reset to
 * whatever the disk now says" path.
 */
export function useStageRoute(stageName: RouteName | null, reprobe: () => void): void {
  const recorded = useRef(false);
  useEffect(() => {
    if (stageName === null) return; // probe in flight
    if (stageName === "editor") return; // owned by useNoteRoute
    if (deepLinkPending()) return; // hold the destination
    if (recorded.current) pushRoute({ name: stageName });
    else replaceRoute({ name: stageName });
    recorded.current = true;
  }, [stageName]);

  // The handler is re-subscribed on every stage change rather than reading a
  // ref: the whole decision is "which stage is showing", so a stale closure
  // here would be a stale ANSWER, not a stale detail.
  useEffect(() => {
    if (stageName === null) return;
    return onRouteChange((route) => {
      if (route.name === stageName) return; // already here — nothing to do
      if (stageName === "editor") return; // back never un-unlocks a vault
      reprobe();
    });
  }, [stageName, reprobe]);
}

/**
 * Bind the open note to the address bar. Mounted inside the editor only.
 *
 * `active` is false until the deep link has settled — see the module doc: the
 * URL must survive untouched until the component that can validate a note id
 * has had its turn.
 */
export function useNoteRoute({
  active,
  selectedId,
  select,
}: {
  active: boolean;
  selectedId: string | null;
  select: (id: string | null) => void;
}): void {
  const recorded = useRef(false);
  useEffect(() => {
    if (!active) return;
    const route = selectedId === null ? { name: "editor" as const } : { name: "editor" as const, noteId: selectedId };
    if (recorded.current) pushRoute(route);
    else replaceRoute(route);
    recorded.current = true;
  }, [active, selectedId]);

  // `select` and `selectedId` both change per selection, so this subscription
  // re-arms with them; there is no long-lived closure to go stale.
  //
  // Gated on `active` for the same reason the recorder is: between the editor
  // mounting and the deep link settling, a back press must not reach the
  // refusal below — the push it performs would overwrite the destination URL
  // with the empty editor, throwing away the note the user came back for.
  useEffect(() => {
    if (!active) return;
    return onRouteChange((route) => {
      if (route.name !== "editor") {
        // The refusal from the module doc, made visible: put the address bar
        // back where the app actually is. Only this hook knows the note.
        pushRoute(
          selectedId === null ? { name: "editor" } : { name: "editor", noteId: selectedId },
        );
        return;
      }
      const next = route.noteId ?? null;
      if (next === selectedId) return; // a mirror of our own push
      select(next);
    });
  }, [active, selectedId, select]);
}
