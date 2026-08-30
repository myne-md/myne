// The one owner of the device-local screen-capture override's client state
// (myne-md/myne#482).
//
// Two surfaces read and write the same setting from opposite sides of the
// unlock boundary: the escape (`src/components/ScreenCaptureEscape.tsx`) and the
// Privacy row that offers the way back
// (`src/components/settings/PrivacyPanel.tsx`). They wrote the mount read and
// the write handler out twice, character for character, including the rule that
// a failed write must not move the switch, and that rule is exactly the one that
// drifts when it has two homes.
//
// ## One cell, shared, and the earlier per-component version was a defect
//
// The state lives at module level, the shape `useTorState` uses and for the same
// reason: the two consumers ARE mounted at once. An earlier revision argued they
// could not be, because the escape rendered only outside the `editor` stage
// while Settings lives inside it. That predicate was then removed (the screens
// with no Settings live inside `editor`), so the claim outlived the code by one
// edit and left a real gap: two independent `view` cells, each read once on
// mount with no refresh, so turning the override ON in Settings and then locking
// left the Unlock screen's escape still reporting it off. It offered "turn
// protection off" over a window that was already capturable, and offered no way
// to turn it back on, on the one surface that has no Settings.
//
// A shared cell also means a write from either surface updates both, which is
// what the Privacy row needs so the per-vault switch above it can go inert in
// the same paint.
//
// ## The capability guard is here rather than at each caller
//
// The other thing two copies cost: the escape's guard sat AFTER its effect, so
// on web it issued a Worker round trip for a command the dispatcher answers
// `Unsupported`, once at boot and again after every lock, for an answer that is
// a `Set.has` away.

import { useCallback, useEffect, useState } from "react";
import {
  getScreenCaptureOverride,
  setScreenCaptureOverride,
  type ScreenCaptureOverrideView,
} from "../lib/screen-capture-override";
import { has } from "../platform/capabilities";

/**
 * `idle` before and between writes, `saving` while one is in flight, `failed`
 * when the last one did not land.
 *
 * One value rather than a `busy`/`failed` pair: the pair can represent
 * "saving and failed at once", which is not a state this flow has.
 */
export type ScreenCaptureOverrideStatus = "idle" | "saving" | "failed";

type Listener = (view: ScreenCaptureOverrideView | null) => void;

let shared: ScreenCaptureOverrideView | null = null;
// Two flags rather than one `readStarted`, and the split is the whole point.
// A single flag set BEFORE the await made a failed read permanent: nothing ever
// retried it, and both surfaces then rendered `null` as "no override" for the
// rest of the process. On the surface that exists for somebody looking at a
// black window, asserting "protection is on" because we could not find out is
// the wrong direction to fail. `inFlight` still collapses concurrent mounts
// into one call; `landed` is what makes the answer final.
let readInFlight = false;
let readLanded = false;
const listeners = new Set<Listener>();

function publish(next: ScreenCaptureOverrideView | null): void {
  shared = next;
  for (const listener of listeners) listener(next);
}

/** Read once per process on success, and once per mount until one succeeds. */
function readOnce(): void {
  if (readInFlight || readLanded) return;
  readInFlight = true;
  void getScreenCaptureOverride()
    .then((next) => {
      readLanded = true;
      publish(next);
    })
    .catch(() => {
      // Do not assert a position we could not read. `null` renders as "no
      // override", which is what every install that never opted out is, while
      // both surfaces still offer the control: the person who needs it is the
      // one who cannot see what went wrong. `readLanded` stays false, so the
      // next mount of either surface asks again. Opening Settings after a
      // failed boot read is the ordinary way out.
    })
    .finally(() => {
      readInFlight = false;
    });
}

/** Test seam: drop the shared cell so each spec starts from a cold process. */
export function resetScreenCaptureOverrideForTest(): void {
  shared = null;
  readInFlight = false;
  readLanded = false;
  listeners.clear();
}

export interface ScreenCaptureOverrideHandle {
  /** The last read, or `null` before one has landed or if it failed. */
  view: ScreenCaptureOverrideView | null;
  status: ScreenCaptureOverrideStatus;
  /**
   * Persist the override and adopt whatever the backend answers, for every
   * mounted surface.
   *
   * Resolves `true` when the write landed. There is deliberately no optimistic
   * flip: the backend writes disk BEFORE the native call, so the returned view
   * is the only thing that describes both, and passing `false` on a
   * flag-launched run leaves the window unprotected however the argument reads.
   */
  save: (disabled: boolean) => Promise<boolean>;
  /** Forget a `failed` status, for a surface reopening after one. */
  clearStatus: () => void;
}

export function useScreenCaptureOverride(): ScreenCaptureOverrideHandle {
  const [view, setView] = useState<ScreenCaptureOverrideView | null>(shared);
  const [status, setStatus] = useState<ScreenCaptureOverrideStatus>("idle");

  useEffect(() => {
    // Where there is no capture affinity to suppress there is nothing to read.
    if (!has("screenCaptureProtection")) return;
    listeners.add(setView);
    readOnce();
    setView(shared);
    return () => {
      listeners.delete(setView);
    };
  }, []);

  const save = useCallback(async (disabled: boolean) => {
    setStatus("saving");
    try {
      publish(await setScreenCaptureOverride(disabled));
      setStatus("idle");
      return true;
    } catch {
      setStatus("failed");
      return false;
    }
  }, []);

  const clearStatus = useCallback(() => setStatus("idle"), []);

  return { view, status, save, clearStatus };
}
