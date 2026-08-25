// `useAutosave` — React hook implementing the γ1+γ2 hybrid autosave
// state machine per `decisions.md` 2026-05-07 "note_update IPC: …
// UI-level autosave coalescing" + 2026-05-15 "Autosave γ1+γ2 hybrid
// concrete timings".
//
// State machine:
//
//   clean  → editing  (on body change while no save in flight, before
//                       idle timer elapses)
//   editing → saving  (idle timer or max timer elapses)
//   saving → saved    (IPC resolves OK)
//   saving → error    (IPC rejects)
//   saved  → editing  (next body change)
//   error  → saving   (retry click) | editing (next body change)
//
// Triggers wired by callers:
// - body change → reset idle timer (γ1); arm max timer (γ2) if not armed.
// - blur (T29)  → `flushIfDirty()` immediately.
// - window close (T28) → `flushIfDirty()` awaited before destruct.
// - vault lock CTA → `flushIfDirty()` awaited before `vault_lock`
//   (canonical flush-on-lock per the 2026-05-07 entry).
//
// Latest-wins gate: if a save is in flight when another fire is due,
// the in-flight completes first; a single follow-up save then runs
// with the latest body. No IPC thrashing. The gate reads `latestBodyRef`,
// which is written during RENDER rather than from an effect — an
// effect-written mirror is one commit stale exactly while a keystroke waits
// for its passive-effect flush, which is when a save's IPC most often
// resolves (myne#167). The save echo is a compare-and-swap on top of that
// (`SavedBodyPatch`), so adoption stays correct even where the ref does not
// help.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isBaseMismatchError } from "../types/note-update-error";
import { sha256Hex } from "./baseHash";
import { AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_MS, saveNote } from "./saveNote";
import { reindexNoteFromBody } from "./vaultIndices";

export type SaveStatus =
  | { status: "clean" }
  | { status: "editing" }
  | { status: "saving" }
  | { status: "saved"; at: Date }
  | { status: "error"; error: unknown }
  /** A `BaseMismatch` rejection is being resolved (conflict copy + reload —
   *  the `onBaseMismatch` handler is in flight). Transient; ends `clean`
   *  once the pane adopts the pulled disk body. */
  | { status: "conflict" };

export type UseAutosaveReturn = {
  status: SaveStatus;
  /** Re-fire the last save with the current body. Used by the Retry button. */
  retry: () => void;
  /** Flush any pending save synchronously (awaitable). No-op when clean. */
  flushIfDirty: () => Promise<void>;
  /** Best-effort, fire-and-forget save of the buffer for whatever note the hook
   *  currently holds — for a caller that is about to stop being that note's
   *  editor (myne#288). Hashless, and it touches no hook state, because the
   *  caller is about to reset that state for a DIFFERENT note. */
  flushOutgoing: () => void;
  /** Adopt an externally-reloaded body as loaded content (not a user edit).
   *  Caller must ensure the buffer is clean first. See the impl docstring. */
  acceptReloadedBody: (reloadedBody: string) => void;
  /** Synchronous "this buffer holds work a caller must not clobber": a save is
   *  in flight, the buffer is dirty, or the live body differs from what the
   *  hook believes is on disk.
   *
   *  Exists because `status` is React STATE set from a passive effect, so an
   *  async continuation (the out-of-band reload's `await noteRead`) can read
   *  `saved`/`clean` for a buffer the user has already typed into and then
   *  overwrite those keystrokes with disk bytes (myne#167's second head).
   *  Every value read here is a ref, and `latestBodyRef` is written during
   *  render — so this answers for the buffer as it is NOW, not as it was one
   *  commit ago. */
  hasPendingWork: () => boolean;
  /** Did the most recent save ATTEMPT fail? See the impl docstring: this is the
   *  settled-check a caller about to read-patch-write the same note needs, and
   *  `hasPendingWork` is not it. */
  lastSaveFailed: () => boolean;
  /** Is a `note_update` in flight RIGHT NOW?
   *
   *  The in-flight disjunct of `hasPendingWork`, on its own, because the other
   *  two are what make `hasPendingWork` the wrong question for a settled-check:
   *  a clean pane whose buffer merely moved on is ordinary, and reporting it as
   *  unsettled refused writes after perfectly normal saves. This one is not
   *  ordinary. A caller that read-patch-writes this note while a save is in
   *  flight has its patch landed on and reverted, or, with the section 11.3
   *  hash on, mints a keep-both conflict copy for a note no remote writer
   *  touched, because the in-flight save declares a base the caller's write has
   *  already replaced. */
  saveInFlight: () => boolean;
};

/**
 * Test-injectable seam — swap `saveNote` for a mock in fake-timer tests.
 * The default points at the production helper. Return value is the
 * patched body (with the fresh `updated:` frontmatter timestamp); the
 * hook mirrors this back via the optional `onSaved` callback so the
 * editor's local state reflects the patch without close-reopen.
 *
 * The third parameter is the §11.3 expected-base fingerprint (SHA-256 hex
 * of the body the hook believes is on disk — `savedBodyRef`); `undefined`
 * = legacy last-write-wins.
 */
export type SaveFn = (
  noteId: string,
  body: string,
  expectedBaseHashHex?: string,
) => Promise<string>;

const DEFAULT_SAVE_FN: SaveFn = saveNote;

/**
 * How a completed save hands its stamped body back to the buffer.
 *
 * NOT a plain value — an UPDATER the caller passes straight to its own
 * `setContent`. `Dispatch<SetStateAction<string>>` is assignable to this, so
 * `useAutosave(…, setContent)` still reads exactly as it did.
 *
 * Handing back a value was myne#167. A save's IPC can resolve in the task slot
 * between a keystroke's commit and React's passive-effect flush, so the body a
 * save was fired with can be one keystroke stale by the time its echo lands.
 * `onSaved(patchedBody)` → `setContent(patchedBody)` then rewrote the buffer
 * from that stale snapshot — the keystroke was gone, and because the rewritten
 * body equalled `savedBodyRef` the hook settled `clean` on a buffer it had just
 * corrupted, so the loss reached disk too.
 *
 * As an updater, React resolves `prev` against the LATEST queued state — the
 * keystroke's own `setContent`, which is already enqueued (and, in a discrete
 * event, already committed) — so the stamped body is adopted only while the
 * buffer is still exactly what was saved, and refused otherwise. That rests on
 * React's ordering guarantee for queued updates rather than on an argument
 * about when passive effects run.
 *
 * Refusal is not a loss: disk holds `patchedBody` either way, `savedBodyRef` is
 * baselined to it, and the pending keystroke re-saves on the next γ1 with a
 * fresh `updated:` stamp (`saveNote` re-stamps unconditionally).
 */
export type SavedBodyPatch = (prevBody: string) => string;

export function useAutosave(
  noteId: string | null,
  body: string,
  saveImpl: SaveFn = DEFAULT_SAVE_FN,
  onSaved?: (applyPatch: SavedBodyPatch) => void,
  /** §11.3 rejection handler. Receives the note the rejected save was FOR and
   *  the body it tried to write — never "whatever the pane is showing now"
   *  (myne#335). */
  onBaseMismatch?: (rejected: {
    readonly noteId: string;
    readonly body: string;
  }) => Promise<void>,
  // §11.3 expected-base guard toggle. The guard exists to catch a SYNC
  // pull-apply landing under the editor between the last save and the next
  // keystroke — its whole purpose is a remote writer. With sync off no remote
  // writer exists, so the on-disk base can only diverge from `savedBodyRef`
  // through the editor's OWN local churn (a create→rename hop the autosave
  // loop never observed, an out-of-band reload that raced a keystroke); every
  // such divergence is a FALSE BaseMismatch that wipes the user's fresh edit
  // into a conflict copy. The caller (PaneView) passes `false` when sync is
  // disabled/not-enrolled, restoring plain last-write-wins. Defaults `true` so
  // existing unit tests (and any guard-opted caller) keep their behavior.
  guardEnabled = true,
): UseAutosaveReturn {
  const [status, setStatus] = useState<SaveStatus>({ status: "clean" });

  // Refs — internal state that should NOT trigger re-renders.
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  /** Latest body at any time — used by the latest-wins gate, `retry`, the
   *  BaseMismatch handoff and the unmount flush.
   *
   *  Written during RENDER, not from an effect (myne#167). An effect-written
   *  mirror is one commit stale for the whole window between a keystroke's
   *  (synchronous, discrete-lane) commit and React's passive-effect flush —
   *  and a save's IPC resolution routinely lands in that window. The
   *  latest-wins gate would then read a pre-keystroke body, conclude "the user
   *  hasn't typed", and mark the buffer clean while it holds unsaved
   *  keystrokes. Same pattern as `onBaseMismatchRef` below, and PaneView's
   *  `autosaveRef`.
   *
   *  Deliberate trade-off: a render React later ABANDONS also writes here.
   *  React restarts an abandoned render from the root with the newest state, so
   *  the last write before any commit is the committed one; the only exposure
   *  is a `fireSave` continuation landing inside the abandon→restart slice,
   *  whose worst case is one extra follow-up save of a body React was about to
   *  render anyway. Never a lost keystroke. */
  const latestBodyRef = useRef<string>(body);
  /** Latest noteId — used by save fires. */
  const noteIdRef = useRef<string | null>(noteId);
  /** True if the latest body has unsaved changes (idle/max timer armed
   *  OR error state holds an un-flushed body). */
  const dirtyRef = useRef<boolean>(false);
  /**
   * The buffer that belonged to the note the hook still holds, captured the
   * instant a DIFFERENT note first renders through this hook (myne#288).
   *
   * `latestBodyRef` is written during render, so by the time the note-change
   * effect runs it already holds the INCOMING note's body. Flushing from it
   * would write note B's text into note A's file — strictly worse than the lost
   * keystrokes it was meant to save. This snapshot is the last body that was
   * still note A's, and it is what the outgoing flush writes.
   *
   * Captured once per switch: a re-render for the same incoming id must not
   * overwrite the snapshot with a body that is already the new note's.
   */
  const outgoingRef = useRef<{ id: string; body: string } | null>(null);
  if (noteIdRef.current !== noteId && noteIdRef.current !== null) {
    if (outgoingRef.current === null || outgoingRef.current.id !== noteIdRef.current) {
      outgoingRef.current = dirtyRef.current
        ? { id: noteIdRef.current, body: latestBodyRef.current }
        : null;
    }
  }
  latestBodyRef.current = body;
  /** True after the first body change post-mount; first mount with
   *  empty body must not arm any timer. */
  const hasEditedRef = useRef<boolean>(false);
  /** Saved body that produced the current `saved` status — lets us tell
   *  if a fresh edit happened during in-flight (latest-wins). */
  const savedBodyRef = useRef<string | null>(null);
  /** Latest `onBaseMismatch` handler — read through a ref at fire time so
   *  `fireSave`'s identity doesn't churn with per-render callbacks (the
   *  `autosaveRef` pattern PaneView already uses in the other direction). */
  const onBaseMismatchRef = useRef(onBaseMismatch);
  onBaseMismatchRef.current = onBaseMismatch;
  /** Latest `onSaved` sink — read through a ref at fire time for the same
   *  reason as `onBaseMismatchRef` above: `fireSave` is memoized on
   *  `[clearTimers, saveImpl, guardEnabled]`, so a directly-closed-over
   *  `onSaved` would be the one captured at first render. */
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const clearTimers = useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (maxTimerRef.current !== null) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
  }, []);

  /**
   * Best-effort save of whatever the hook currently holds, for whatever note it
   * currently holds it for. Used by every path that is about to STOP being this
   * note's editor: the note-switch reset below, the unmount cleanup, and the
   * pane's cached state swap (myne#288).
   *
   * Deliberately HASHLESS (legacy last-write-wins). By the time this runs there
   * is no live pane to run the keep-both handler, so a `BaseMismatch` rejection
   * would drop the keystrokes irrecoverably — whereas a legacy clobber is later
   * reconciled by the sync engine's own server-side keep-both, because the
   * remote revision still exists on the server.
   *
   * It deliberately does NOT touch `dirtyRef`, `savedBodyRef` or `status`: the
   * caller is about to reset them for a different note, and a late async write
   * into them would be a write about the wrong note.
   */
  const flushOutgoing = useCallback((): void => {
    if (inFlightRef.current !== null) return;
    // Prefer the switch snapshot: once a different note has rendered through
    // this hook, `latestBodyRef` is already the incoming note's body and writing
    // it under the outgoing id would corrupt the outgoing note.
    const pending = outgoingRef.current;
    const id = pending?.id ?? noteIdRef.current;
    const text = pending?.body ?? latestBodyRef.current;
    if (id === null || (pending === null && !dirtyRef.current)) return;
    outgoingRef.current = null;
    void saveImplRef.current(id, text).catch(() => {
      /* best-effort — a switch must never be blocked by a failed save */
    });
  }, []);
  /** Set true by `fireSave`'s error arm, cleared at the top of every attempt and
   *  at every point the pane stops holding the note that attempt was for.
   *  Read through `lastSaveFailed` below. */
  const saveFailedRef = useRef(false);

  const flushOutgoingRef = useRef(flushOutgoing);
  flushOutgoingRef.current = flushOutgoing;

  useEffect(() => {
    const prevId = noteIdRef.current;
    // NOTE: `noteIdRef` is advanced AFTER the flush below, not before — the
    // outgoing save has to be attributed to the note it came from (myne#288).
    // Note-selection change → reset internal state. The previous note's
    // dirty timers + saved-status must not bleed into the new note (or
    // into the no-selection BottomBar). The `hasEditedRef` guard re-arms
    // so the body-change effect treats the new body as "loaded content"
    // not "user edit".
    if (prevId !== noteId) {
      // myne#288 — FLUSH BEFORE RESETTING.
      //
      // This used to drop the armed γ1/γ2 timers and clear `dirtyRef` without
      // firing a save, even though `prevId` and `latestBodyRef` still held
      // everything a save needs. Every KEYBOARD switch path lands here with the
      // editor still focused — Ctrl+Tab, Mod-W, Mod-[ / Mod-], the vim `:q`
      // bridge — and none of them calls the flush registry, so the only flush in
      // the whole notes domain was the incidental DOM blur a MOUSE click
      // produces. Up to ~10 s of typing was destroyed with no error, no toast
      // and a status that reset to `clean`.
      //
      // Worse than a lost buffer: the outgoing pane's EditorState is cached, so
      // switching back showed the text again while the autosave had baselined it
      // as if it were on disk. The user saw their words and had no signal they
      // were unsaved, until the tab closed or the cache was evicted.
      //
      // Deliberately HASHLESS, for the same reason the unmount cleanup below is:
      // there is no live pane left to run the keep-both handler, so a
      // BaseMismatch rejection here would drop the keystrokes irrecoverably —
      // whereas a legacy clobber is later reconciled by the sync engine's own
      // server-side keep-both.
      flushOutgoingRef.current();
      noteIdRef.current = noteId;
      clearTimers();
      inFlightRef.current = null;
      dirtyRef.current = false;
      hasEditedRef.current = false;
      savedBodyRef.current = null;
      // The flag answers "did the save that just ran fail", and after a switch
      // there IS no such save: this pane now holds a different note. Leaving it
      // set makes `flushIfDirty` return immediately (the pane is clean, nothing
      // re-fires) while `lastSaveFailed` keeps reporting the OLD note's failure,
      // so every out-of-band frontmatter write refuses indefinitely: the cover
      // toasts write-failed, both template converts no-op, a folder rename
      // reports an unsettled save and vim `:w` reports a failure for a write
      // that had nothing to do.
      saveFailedRef.current = false;
      setStatus({ status: "clean" });
    } else {
      noteIdRef.current = noteId;
    }
  }, [noteId, clearTimers]);

  // The fire function — handles latest-wins gate + IPC dispatch +
  // status transitions. Always called via the timers or via
  // flushIfDirty / retry.
  const fireSave = useCallback(async (): Promise<void> => {
    clearTimers();
    // Cleared at the top of every attempt: the question this answers is "did the
    // save that just ran fail", not "has anything ever failed" (myne-md/myne#520).
    saveFailedRef.current = false;
    const id = noteIdRef.current;
    if (id === null) {
      // No selected note → can't save. Stay in current state.
      return;
    }
    if (inFlightRef.current !== null) {
      // Another save already running. Wait for it; the in-flight's
      // own resolve handler checks for a fresher body and re-fires.
      return inFlightRef.current;
    }
    const bodyAtFire = latestBodyRef.current;
    setStatus({ status: "saving" });
    // Set when the latest-wins branch below hands the in-flight slot to a
    // follow-up fire (myne#333). Without it the outer `finally` ran after that
    // branch's `return` and ERASED the follow-up's registration, so every guard
    // that keys on `inFlightRef` — `flushIfDirty`, `retry`, the unmount cleanup
    // — saw an idle hook while a `note_update` was still in flight.
    let handedOff = false;
    const promise = (async () => {
      try {
        // §11.3 expected-base fingerprint: hash of the body this hook
        // believes is on disk (`savedBodyRef`). Fail-open on any hashing
        // hiccup — autosave must never break on the guard's plumbing;
        // an omitted hash just means legacy last-write-wins for this fire.
        let expectedBaseHashHex: string | undefined;
        if (guardEnabled && savedBodyRef.current !== null) {
          try {
            expectedBaseHashHex = await sha256Hex(savedBodyRef.current);
          } catch {
            expectedBaseHashHex = undefined;
          }
        }
        const patchedBody = await saveImpl(id, bodyAtFire, expectedBaseHashHex);
        // Latest-wins gate: if the body changed during the IPC, the
        // current body differs from `bodyAtFire`. Re-arm the idle timer
        // (the body change handler would have armed it if it fired
        // first; double-arm is idempotent because we clearTimers above).
        if (latestBodyRef.current !== bodyAtFire) {
          // Don't transition to saved — we still have unsaved work.
          // Stay in `saving` until the follow-up save fires.
          // Schedule the follow-up immediately (no idle wait — we
          // already paid the latency once; the user expects continued
          // saving).
          //
          // What is ON DISK is what the IPC actually wrote — the PATCHED body
          // (`saveNote` stamps `updated:` and returns the stamped bytes), never
          // the pre-patch `bodyAtFire`. `savedBodyRef` is the §11.3
          // expected-base source, so recording `bodyAtFire` here declares a base
          // the disk does not hold: the follow-up save is rejected
          // `BaseMismatch` and `onBaseMismatch` mints a conflict copy for a note
          // only this editor ever touched. Latent while this branch almost never
          // ran; load-bearing now that the latest-wins gate above reads a
          // render-synchronous ref and so trips whenever the user types through
          // a save.
          savedBodyRef.current = patchedBody;
          setStatus({ status: "saving" });
          inFlightRef.current = null;
          dirtyRef.current = true;
          // Fire the follow-up, and tell the `finally` that the slot now
          // belongs to it (myne#333).
          //
          // What the erased registration cost: `flushIfDirty` resolved while
          // the follow-up `note_update` was still in flight, so the close paths
          // proceeded — the web `pagehide` chain discards the page and the
          // desktop close-intercept calls `destroy()`, taking the aborted IPC
          // and the keystrokes typed during the first save with them. And
          // `fireSave` re-entered instead of joining, so a SECOND concurrent
          // `note_update` ran for the same note: with sync on both declare the
          // same expected-base hash, so the one landing second is rejected
          // `BaseMismatch` and mints a keep-both conflict copy for a note no
          // remote writer ever touched; with sync off both are hashless, so an
          // out-of-order landing writes the older body over the newer.
          handedOff = true;
          void fireSave();
          return;
        }
        // The gate above says the user hasn't typed since the save fired →
        // offer the patched body back so the editor's local content reflects
        // the fresh `updated:` timestamp without a close-reopen reload. The
        // offer is a compare-and-swap (see the `onSaved` call below), because
        // this gate reads a ref and the buffer is React state: `latestBodyRef`
        // is render-synchronous, but the CAS is what makes the adoption correct
        // without depending on that at all.
        //
        // `savedBodyRef.current` is set to the PATCHED body — what the IPC
        // actually wrote — so the subsequent body-change effect (when the
        // parent adopts it) sees `body === savedBodyRef.current` → routes to
        // the "revert to last-saved" clean branch (no re-fire loop). When the
        // CAS instead REFUSES, that same effect sees a body that differs from
        // it, re-marks the buffer dirty and re-arms γ1 — so the keystroke that
        // caused the refusal is saved on the next cycle.
        savedBodyRef.current = patchedBody;
        dirtyRef.current = false;
        setStatus({ status: "saved", at: new Date() });
        // MYND-31: live re-index from the just-saved body (decrypt-free —
        // the body is already in V8). Best-effort, fire-and-forget so a
        // VaultIndices hiccup never affects the save status.
        void reindexNoteFromBody(id, patchedBody);
        const onSavedNow = onSavedRef.current;
        if (onSavedNow !== undefined && patchedBody !== bodyAtFire) {
          // Compare-and-swap, not a bare set (myne#167): the ONLY buffer this
          // stamped body may replace is the one it was derived from. See the
          // `SavedBodyPatch` docstring for why the gate above is not enough on
          // its own.
          onSavedNow((prev) => (prev === bodyAtFire ? patchedBody : prev));
        }
      } catch (err) {
        // §11.3 BaseMismatch → local keep-both, awaited INSIDE the catch:
        // `inFlightRef` stays non-null until the handler finishes, so
        // `retry()` and duplicate fires no-op, and `flushIfDirty()` (lock /
        // close / quit) transitively awaits the conflict-copy creation —
        // no lost keystrokes on a close-flush. The handler ends by adopting
        // the pulled disk body via `acceptReloadedBody` (→ clean); a handler
        // throw falls through to the plain error state, and Retry re-runs
        // the whole path (mismatch again → handler retried — converges).
        if (isBaseMismatchError(err) && onBaseMismatchRef.current !== undefined) {
          setStatus({ status: "conflict" });
          try {
            // The note the REJECTED save was for, and the body it tried to
            // write (myne#335).
            //
            // This used to pass `latestBodyRef.current` to a handler bound to
            // the pane's CURRENT note — so after a note switch the conflict
            // copy was attributed to the wrong note, carrying either that
            // note's untouched body or the previous note's edited one. A
            // spurious duplicate in the sidebar and the Conflicts view either
            // way, and the rejected keystrokes were never preserved into a
            // copy — which is the sole purpose of the §11.3 handler. They then
            // survived only in the volatile per-pane EditorState cache, and
            // even on return `acceptReloadedBody` marks them saved, so they are
            // never written.
            //
            // While the hook is still on the same note, the newest buffer is
            // the right thing to preserve; once it has moved on, `bodyAtFire`
            // is the last text that belonged to `id`.
            const rejectedBody =
              noteIdRef.current === id ? latestBodyRef.current : bodyAtFire;
            await onBaseMismatchRef.current({ noteId: id, body: rejectedBody });
            return;
          } catch {
            // fall through to the error state below
          }
        }
        dirtyRef.current = true;
        saveFailedRef.current = true;
        setStatus({ status: "error", error: err });
      } finally {
        // Only when this invocation still owns the slot — see `handedOff`.
        if (!handedOff) inFlightRef.current = null;
      }
    })();
    inFlightRef.current = promise;
    return promise;
  }, [clearTimers, saveImpl, guardEnabled]);

  // Body-change effect — handles dirty marking + timer arming.
  useEffect(() => {
    // Skip the initial mount (body hasn't really "changed" yet — it's
    // the loaded content). Only treat subsequent body changes as edits.
    if (!hasEditedRef.current) {
      hasEditedRef.current = true;
      // Pre-record the body as "saved" so a no-op no-edit unmount
      // doesn't fire spurious saves. Status stays `clean`.
      savedBodyRef.current = body;
      return;
    }

    // A change happened.
    if (savedBodyRef.current !== null && body === savedBodyRef.current) {
      // User reverted to last-saved state, so back to clean. `savedBodyRef` is
      // only ever set by a save that SUCCEEDED, so matching it means the buffer
      // equals the disk and the last attempt's failure has been undone by the
      // user rather than by a write.
      dirtyRef.current = false;
      saveFailedRef.current = false;
      clearTimers();
      setStatus({ status: "saved", at: new Date() });
      return;
    }

    dirtyRef.current = true;
    setStatus((prev) => {
      if (prev.status === "saving") return prev; // keep saving label until in-flight resolves
      if (prev.status === "error") return prev; // user must Retry or auto-recover
      return { status: "editing" };
    });

    // γ1 idle-debounce — reset on every body change.
    if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      void fireSave();
    }, AUTOSAVE_IDLE_MS);

    // γ2 max-debounce — arm only if not already running.
    if (maxTimerRef.current === null) {
      maxTimerRef.current = setTimeout(() => {
        maxTimerRef.current = null;
        void fireSave();
      }, AUTOSAVE_MAX_MS);
    }
  }, [body, clearTimers, fireSave]);

  /**
   * Adopt an externally-reloaded body (a sync pull / snapshot-restore wrote a
   * new `.myn` and the pane re-read it) as freshly-LOADED content — NOT a user
   * edit. Re-baselines `savedBodyRef` to it so the body-change effect takes its
   * "matches last-saved" clean branch instead of marking the buffer dirty.
   *
   * Without this, a sync-pulled reload looks identical to a local edit: the next
   * sync then sees the note as locally-changed while the server also advanced,
   * and stages a spurious keep-both conflict for a note the user never touched
   * (the false-conflict bug, MYND sync Bug 1). Callers MUST invoke this ONLY
   * when the buffer is clean — re-baselining over real unsaved edits would lose
   * them. Second sanctioned caller: the `onBaseMismatch` keep-both handler —
   * there the "unsaved edits" have ALREADY been preserved into a conflict copy
   * before this re-baseline runs (`src/notes/baseMismatch.ts`).
   */
  const acceptReloadedBody = useCallback(
    (reloadedBody: string) => {
      clearTimers();
      inFlightRef.current = null;
      dirtyRef.current = false;
      hasEditedRef.current = true;
      savedBodyRef.current = reloadedBody;
      // Same reason as the note-switch reset: the buffer has been re-baselined
      // against bytes that ARE on disk, so whatever the last attempt did is no
      // longer a fact about this pane.
      saveFailedRef.current = false;
      // Bridge only: the next render's write to `latestBodyRef` is
      // authoritative. Every caller batches `setContent(reloadedBody)` with
      // this call, so that render carries the same body — this line just
      // covers the gap until it commits.
      latestBodyRef.current = reloadedBody;
      setStatus({ status: "clean" });
    },
    [clearTimers],
  );

  const flushIfDirty = useCallback(async (): Promise<void> => {
    if (!dirtyRef.current && inFlightRef.current === null) return;
    if (inFlightRef.current !== null) {
      await inFlightRef.current;
      // If a follow-up save was queued (latest-wins), it will have
      // re-armed in-flight; await again.
      if (inFlightRef.current !== null) {
        await inFlightRef.current;
      }
      return;
    }
    await fireSave();
  }, [fireSave]);

  const retry = useCallback(() => {
    if (inFlightRef.current !== null) return;
    void fireSave();
  }, [fireSave]);

  // Ref-only, so it is correct inside an async continuation where `status`
  // (React state, set from a passive effect) still reads `saved`/`clean` for a
  // buffer the user has already typed into. The third disjunct is what catches
  // that case: `latestBodyRef` is render-written, `savedBodyRef` is what the
  // last IPC actually put on disk.
  const hasPendingWork = useCallback(
    () =>
      inFlightRef.current !== null ||
      dirtyRef.current ||
      (savedBodyRef.current !== null &&
        latestBodyRef.current !== savedBodyRef.current),
    [],
  );

  /** See the type docstring: the in-flight disjunct alone. */
  const saveInFlight = useCallback(() => inFlightRef.current !== null, []);

  /**
   * Did the most recent save ATTEMPT fail?
   *
   * A narrower question than `hasPendingWork`, and the difference is the whole
   * reason this exists (myne-md/myne#520). `hasPendingWork` is a "do not clobber
   * me" flag and answers true for a buffer that merely moved on while a
   * perfectly successful save was in flight, which is the ordinary state right
   * after a flush. Using it as a settled-check refused every out-of-band
   * frontmatter write that followed a normal save: the cover never landed and
   * the user got a write-failed toast, measured against the E2E suite before it
   * shipped.
   *
   * What a caller about to read-patch-write the same note needs to know is only
   * whether the flush it just awaited actually persisted, and `fireSave` is the
   * one place that knows. A ref, not `status`, for the reason the whole file
   * gives: `status` is React state written from a passive effect.
   */
  const lastSaveFailed = useCallback(() => saveFailedRef.current, []);

  // Hold the latest `saveImpl` in a ref so the unmount cleanup sees
  // the current impl, not the one captured at first render.
  const saveImplRef = useRef(saveImpl);
  useEffect(() => {
    saveImplRef.current = saveImpl;
  }, [saveImpl]);

  // Cleanup on unmount — clear timers + best-effort fire if dirty AND
  // no save is currently in flight. Skipping when in-flight prevents
  // the second concurrent save that could land out-of-order and
  // clobber the user's most recent edit.
  //
  // Deliberately HASHLESS (legacy last-write-wins): on unmount there is no
  // live pane to run the keep-both handler, so a BaseMismatch rejection here
  // would drop the keystrokes irrecoverably — whereas a legacy clobber is
  // later reconciled by the sync engine's own server-side keep-both (the
  // remote revision still exists on the server).
  useEffect(() => {
    return () => {
      clearTimers();
      flushOutgoingRef.current();
    };
    // Intentionally empty deps — runs only on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useMemo(
    () => ({
      status,
      retry,
      flushIfDirty,
      flushOutgoing,
      acceptReloadedBody,
      hasPendingWork,
      lastSaveFailed,
      saveInFlight,
    }),
    [
      status,
      retry,
      flushIfDirty,
      flushOutgoing,
      acceptReloadedBody,
      hasPendingWork,
      lastSaveFailed,
      saveInFlight,
    ],
  );
}
