// The live-note policy: one session per note, opened when a note is shown and
// released when it leaves, with every save routed through it while it is open.
//
// # Why this lives in the cross-client decision layer
//
// While a live session owns a note it is the SINGLE durable writer (`SYNC-33`):
// the backend refuses a stateless `note_update` for that note with
// `NoteUpdateError::LiveSessionOpen`. So every save the app would make has to be
// routed through the session instead, and the session has to be opened when a
// note is shown and closed when it leaves. That routing is a DECISION, and both
// the desktop and the mobile client make it identically, which is exactly the
// entry criterion `@myne/client-core` states: a module belongs here only if both
// clients answer the same question AND it touches no host at all.
//
// # No host, so the host is injected
//
// This module has NO imports. The second half of the criterion is enforced by
// `scripts/check-platform-seam.mjs` (zero Tauri imports, and not even the runtime
// global's name in a comment), and it is why the five transport calls and the two
// capability answers arrive through {@link LiveNoteHost} rather than being read
// from a client tree. The shape is the one the shared editor engine already uses
// for its host seam, so this is an established pattern rather than a new one.
//
// # A factory, not a module-scope host
//
// The obvious alternative is a module-scope singleton plus a `configure` call.
// That leaves a mutable binding inside live policy state, so a second wiring (a
// test, a story, a second mount) silently retargets the first. The refcount is
// per-instance state and belongs with the host that will service it, so both are
// created together.
//
// # Best-effort by design
//
// A drawing note, a locked vault or a client without the session capability
// leaves the note UN-tracked, so the ordinary durable path runs and nothing
// refuses. A failed open releases the hold rather than leaving a note tracked
// that no session backs.

/**
 * The optional guards a save through the session carries.
 *
 * `expectedBaseHashHex` is the §11.3 expected-base guard: SHA-256 hex of the text
 * the caller believes is current. When the session's own text hashes differently
 * the host rejects with `{ kind: "BaseMismatch" }` and writes nothing.
 *
 * `base` is the text the caller's markdown was DERIVED from. When the session has
 * moved past it (a peer edit merged in meanwhile), the core three-way merges
 * instead of replacing, so a save from a stale buffer cannot delete a peer's edit.
 */
export interface LivePatchOptions {
  expectedBaseHashHex?: string;
  base?: string;
  /**
   * Called with the session's text after the patch, synchronously, BEFORE the
   * patch settles, so a merge drain waiting on {@link LiveNotePolicy.settledPatches}
   * sees its effect. Never sent to the host: each transport picks its fields.
   *
   * It is per CALL rather than a listener on every patch (myne-md/myne#849 review
   * round 4) because only the editor's OWN saves may move the editor's mirror of
   * the session, and only to the text it SENT. A move, a cover or a template flag
   * writes text the buffer does not hold, so moving the mirror on their patch
   * reads the buffer as having reverted them, and the next save deletes them; and
   * moving it to the RETURNED text on the editor's own save hides a peer edit the
   * core merged into that save, which the buffer then never receives.
   */
  onApplied?: (after: string) => void;
}

/** One local edit: replace the UTF-16 range `[from, to)` with `insert`. */
export interface LocalSplice {
  from: number;
  to: number;
  insert: string;
}

/**
 * The client-supplied half of the policy. Each call is the client's transport
 * binding for one live-session command, and each capability answer is the
 * client's own descriptor reading.
 */
export interface LiveNoteHost {
  /** Open (or attach to) a live session for `noteId`. Idempotent. */
  open(noteId: string): Promise<void>;
  /** Flush the pending durable write and drop the session. */
  close(noteId: string): Promise<void>;
  /**
   * Persist a re-derived note through the session, under the guards in `opts`.
   * Resolves with the session's WHOLE markdown after the patch, which differs
   * from `markdown` whenever `base` made the core merge.
   */
  patch(noteId: string, markdown: string, opts?: LivePatchOptions): Promise<string>;
  /** Drain the body splices a sync pull merged into an open session. */
  takeRemoteSplices(noteId: string): Promise<LocalSplice[]>;
  /**
   * Report this device's caret/selection for an open note. Rejects are the
   * caller's to swallow: presence is best-effort and must never fail a save.
   */
  setPresence(
    noteId: string,
    cursor: number | null,
    selection: [number, number] | null,
    label: string | null,
  ): Promise<void>;
  /** Whether this client can hold and report peer presence at all. */
  peerPresenceAvailable(): boolean;
  /** Whether this client renders peers' carets and selections. */
  awarenessCursorsAvailable(): boolean;
}

/** The policy surface a client imports and calls. */
export interface LiveNotePolicy {
  /** Whether a live session opened by this app currently owns `noteId`. */
  isLiveNote(noteId: string): boolean;
  openLiveNote(noteId: string): Promise<void>;
  closeLiveNote(noteId: string): Promise<void>;
  /**
   * Drop the WHOLE session for `noteId` regardless of how many holds it has,
   * for a caller that erases the note and owns none of them. `true` when no
   * session owns the note afterwards, `false` when the flush failed and the
   * holds were restored.
   */
  evictLiveNote(noteId: string): Promise<boolean>;
  /**
   * The save funnel: the session's text after the patch when the write went
   * through the session, `null` when the caller must use the stateless path
   * instead. A `BaseMismatch` from the session's expected-base guard is rethrown,
   * never read as "no session".
   */
  patchLiveNote(
    noteId: string,
    markdown: string,
    opts?: LivePatchOptions,
  ): Promise<string | null>;
  takeRemoteSplices(noteId: string): Promise<LocalSplice[]>;
  reportLivePresence(
    noteId: string,
    cursor: number | null,
    selection: [number, number] | null,
  ): void;
  /**
   * Resolve once every `patchLiveNote` for `noteId` in flight NOW has settled,
   * success or failure. Never rejects; resolves at once when none is in flight.
   */
  settledPatches(noteId: string): Promise<void>;
  /**
   * How many `patchLiveNote` calls for `noteId` have STARTED in this policy's
   * lifetime. A reader that compares it before and after an await learns whether
   * one of this device's own writes could have landed in between.
   */
  patchEpoch(noteId: string): number;
}

/** The `LiveSessionCommandError` is `{ kind: "NotOpen" }` (or a bare string). */
export function isLiveNotOpen(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    (e as { kind?: unknown }).kind === "NotOpen"
  );
}

/**
 * Build the policy over `host`.
 *
 * A REFCOUNT per note id, not a set: two views can show the same note, and the
 * session is one per `(vault, note)` (`SYNC-34`), so the first view to open it
 * opens the session and only the last to close it drops the session. A set would
 * have let one view's unmount close the session out from under the other.
 */
export function createLiveNotePolicy(host: LiveNoteHost): LiveNotePolicy {
  const openCounts = new Map<string, number>();
  /**
   * The in-flight `host.open` per note.
   *
   * The refcount is bumped BEFORE that promise resolves, so a save landing in the
   * same tick reaches `patch` first and the registry answers `NotOpen`. Without
   * this map that answer is read as "there is no session", the note is
   * un-tracked, and the caller falls back to a STATELESS write which the registry
   * then refuses because the session exists after all (myne-md/myne#849 review).
   * The map is what lets the patch tell "not yet" apart from "gone".
   */
  const openInFlight = new Map<string, Promise<void>>();

  function isLiveNote(noteId: string): boolean {
    return openCounts.has(noteId);
  }

  async function openLiveNote(noteId: string): Promise<void> {
    if (!host.peerPresenceAvailable()) return;
    const held = openCounts.get(noteId) ?? 0;
    // Counted OPTIMISTICALLY before the open resolves, so a save landing in the
    // same tick still routes to the session rather than being refused.
    openCounts.set(noteId, held + 1);
    if (held > 0) return; // the session is already open; this is an attach
    const flight = (async () => {
      try {
        await host.open(noteId);
      } catch {
        openCounts.delete(noteId);
      }
    })();
    openInFlight.set(noteId, flight);
    try {
      await flight;
    } finally {
      if (openInFlight.get(noteId) === flight) openInFlight.delete(noteId);
    }
  }

  async function closeLiveNote(noteId: string): Promise<void> {
    let held = openCounts.get(noteId);
    if (held === undefined) return;
    if (held > 1) {
      openCounts.set(noteId, held - 1);
      return;
    }
    // The count is bumped BEFORE `host.open` resolves, so a close landing while
    // that open is still in flight would call `host.close` against a session the
    // backend has not created yet: the close takes the `NotOpen` arm and returns,
    // and the open then lands with NO hold tracking it, so every later save is
    // refused as a stateless write beside a live session (myne-md/myne#849
    // review). Wait the flight out, then re-read the count.
    const flight = openInFlight.get(noteId);
    if (flight !== undefined) {
      await flight.catch(() => {});
      held = openCounts.get(noteId);
      if (held === undefined) return; // the open failed; there is nothing to close
      if (held > 1) {
        openCounts.set(noteId, held - 1);
        return;
      }
    }
    openCounts.delete(noteId);
    try {
      await host.close(noteId);
    } catch (e) {
      if (isLiveNotOpen(e)) return; // already closed, or the vault left
      // The flush FAILED, which on the core's side means the session is still in
      // the registry (it removes the note only on a successful flush). Dropping
      // the hold here would tell every later save "there is no session", and the
      // stateless path it would then take is REFUSED by the registry
      // (myne-md/myne#849 review). Re-arm the hold instead, so the funnel stays
      // engaged and the next save retries the flush through the session.
      openCounts.set(noteId, (openCounts.get(noteId) ?? 0) + 1);
    }
  }

  /**
   * Evict rather than release: a delete path holds no hold of its own, so a
   * `closeLiveNote` from it released the hold of whatever VIEW had the note open,
   * and with two views the count fell out of step with the views for good
   * (myne-md/myne#849 review, D7). This takes every hold in one step and closes
   * once.
   */
  async function evictLiveNote(noteId: string): Promise<boolean> {
    // An open still in flight would land after the close and recreate the session
    // underneath the erase, so wait it out first and read the count after.
    const flight = openInFlight.get(noteId);
    if (flight !== undefined) await flight.catch(() => {});
    // **And the patches already inside the session.** A patch in flight applies
    // under the session lock and its flush runs AFTER it, so a close that did not
    // wait for it seals a blob that does not carry those bytes, and the delete
    // path then erases beside them (myne-md/myne#849 review, D8). `settledPatches`
    // is the same signal the merge drains use, and it never rejects.
    const inFlightPatches = patchesInFlight.get(noteId);
    if (inFlightPatches !== undefined && inFlightPatches.size > 0) {
      await Promise.all([...inFlightPatches]);
    }
    const held = openCounts.get(noteId);
    if (held === undefined) return true; // no session; the erase is safe
    openCounts.delete(noteId);
    try {
      await host.close(noteId);
      return true;
    } catch (e) {
      if (isLiveNotOpen(e)) return true; // already closed, or the vault left
      // The flush failed, so the session is still in the core's registry (see
      // `closeLiveNote`). Give back every hold this took, on top of any a view took
      // while the close was in flight, so the views' later releases still balance.
      openCounts.set(noteId, (openCounts.get(noteId) ?? 0) + held);
      return false;
    }
  }

  /**
   * The settle signal of every patch still in flight, per note, and the count of
   * patches ever started. Both exist for the editors' merge drains, which read
   * the session's text and diff it against a mirror of what the session held: a
   * read that overlaps one of this device's own patches sees that patch as a
   * peer's change and applies it a second time. Lifted here from the mobile shim
   * (myne-md/myne#849 review round 4) when the desktop pane took the same drain.
   */
  const patchesInFlight = new Map<string, Set<Promise<void>>>();
  const patchStarts = new Map<string, number>();

  async function patchLiveNote(
    noteId: string,
    markdown: string,
    opts?: LivePatchOptions,
  ): Promise<string | null> {
    if (!openCounts.has(noteId)) return null;
    patchStarts.set(noteId, (patchStarts.get(noteId) ?? 0) + 1);
    // `onApplied` runs INSIDE the tracked promise, so the settle signal cannot
    // resolve before it has, however many ticks a waiter adds or removes.
    const call = (async () => {
      const after = await patchThroughSession(noteId, markdown, opts);
      if (after !== null) opts?.onApplied?.(after);
      return after;
    })();
    const settled = call.then(
      () => {},
      () => {},
    );
    let inFlight = patchesInFlight.get(noteId);
    if (inFlight === undefined) {
      inFlight = new Set();
      patchesInFlight.set(noteId, inFlight);
    }
    inFlight.add(settled);
    try {
      return await call;
    } finally {
      inFlight.delete(settled);
      if (inFlight.size === 0 && patchesInFlight.get(noteId) === inFlight) {
        patchesInFlight.delete(noteId);
      }
    }
  }

  async function settledPatches(noteId: string): Promise<void> {
    const inFlight = patchesInFlight.get(noteId);
    if (inFlight === undefined || inFlight.size === 0) return;
    await Promise.all([...inFlight]);
  }

  function patchEpoch(noteId: string): number {
    return patchStarts.get(noteId) ?? 0;
  }

  async function patchThroughSession(
    noteId: string,
    markdown: string,
    opts?: LivePatchOptions,
  ): Promise<string | null> {
    // The transport answers the session's whole text, and `string | null` is the
    // contract every caller reads: `null` means NO SESSION, so the caller takes
    // its stateless path. An off-contract `undefined` (an older or mocked
    // binding) is therefore a routed write with no text rather than "no
    // session": reading it as the latter would hand the note to the batch the
    // registry refuses beside an open session, which is the fork this policy
    // exists to close.
    const routedText = (after: unknown): string => (typeof after === "string" ? after : "");
    try {
      return routedText(await host.patch(noteId, markdown, opts));
    } catch (e) {
      // Only `NotOpen` means "no session". Anything else, the guard's
      // `BaseMismatch` included, is the caller's to handle: reading it as "no
      // session" would send a guarded write down the stateless path, which the
      // registry refuses beside a live session anyway.
      if (!isLiveNotOpen(e)) throw e;
      // `NotOpen` on its own is ambiguous. A pending open is the ordinary cause,
      // and the fallback it would otherwise take is a stateless write that FAILS
      // while the session exists, so wait for that open and try once more before
      // concluding the session is gone.
      const flight = openInFlight.get(noteId);
      if (flight !== undefined) {
        await flight.catch(() => {});
        if (openCounts.has(noteId)) {
          try {
            return routedText(await host.patch(noteId, markdown, opts));
          } catch (retry) {
            if (!isLiveNotOpen(retry)) throw retry;
          }
        }
      }
      // Now it really is gone (closed out from under us, or the open failed):
      // release the hold so the caller's durable path is the correct one.
      openCounts.delete(noteId);
      return null;
    }
  }

  async function takeRemoteSplices(noteId: string): Promise<LocalSplice[]> {
    if (!openCounts.has(noteId)) return [];
    return host.takeRemoteSplices(noteId);
  }

  function reportLivePresence(
    noteId: string,
    cursor: number | null,
    selection: [number, number] | null,
  ): void {
    if (!host.awarenessCursorsAvailable()) return;
    if (!openCounts.has(noteId)) return;
    void host.setPresence(noteId, cursor, selection, null).catch(() => {});
  }

  return {
    isLiveNote,
    openLiveNote,
    closeLiveNote,
    evictLiveNote,
    patchLiveNote,
    takeRemoteSplices,
    reportLivePresence,
    settledPatches,
    patchEpoch,
  };
}
