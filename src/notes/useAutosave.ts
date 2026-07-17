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
// with the latest body. No IPC thrashing.

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
  /** Adopt an externally-reloaded body as loaded content (not a user edit).
   *  Caller must ensure the buffer is clean first. See the impl docstring. */
  acceptReloadedBody: (reloadedBody: string) => void;
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

export function useAutosave(
  noteId: string | null,
  body: string,
  saveImpl: SaveFn = DEFAULT_SAVE_FN,
  onSaved?: (patchedBody: string) => void,
  onBaseMismatch?: (staleBufferBody: string) => Promise<void>,
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
  /** Latest body at any time — used by latest-wins gate + retry. */
  const latestBodyRef = useRef<string>(body);
  /** True if the latest body has unsaved changes (idle/max timer armed
   *  OR error state holds an un-flushed body). */
  const dirtyRef = useRef<boolean>(false);
  /** True after the first body change post-mount; first mount with
   *  empty body must not arm any timer. */
  const hasEditedRef = useRef<boolean>(false);
  /** Latest noteId — used by save fires. */
  const noteIdRef = useRef<string | null>(noteId);
  /** Saved body that produced the current `saved` status — lets us tell
   *  if a fresh edit happened during in-flight (latest-wins). */
  const savedBodyRef = useRef<string | null>(null);
  /** Latest `onBaseMismatch` handler — read through a ref at fire time so
   *  `fireSave`'s identity doesn't churn with per-render callbacks (the
   *  `autosaveRef` pattern PaneView already uses in the other direction). */
  const onBaseMismatchRef = useRef(onBaseMismatch);
  onBaseMismatchRef.current = onBaseMismatch;

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

  // Keep refs in sync with props.
  useEffect(() => {
    latestBodyRef.current = body;
  }, [body]);
  useEffect(() => {
    const prevId = noteIdRef.current;
    noteIdRef.current = noteId;
    // Note-selection change → reset internal state. The previous note's
    // dirty timers + saved-status must not bleed into the new note (or
    // into the no-selection BottomBar). The `hasEditedRef` guard re-arms
    // so the body-change effect treats the new body as "loaded content"
    // not "user edit".
    if (prevId !== noteId) {
      clearTimers();
      inFlightRef.current = null;
      dirtyRef.current = false;
      hasEditedRef.current = false;
      savedBodyRef.current = null;
      setStatus({ status: "clean" });
    }
  }, [noteId, clearTimers]);

  // The fire function — handles latest-wins gate + IPC dispatch +
  // status transitions. Always called via the timers or via
  // flushIfDirty / retry.
  const fireSave = useCallback(async (): Promise<void> => {
    clearTimers();
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
          savedBodyRef.current = bodyAtFire;
          setStatus({ status: "saving" });
          inFlightRef.current = null;
          dirtyRef.current = true;
          // Fire the follow-up.
          void fireSave();
          return;
        }
        // User hasn't typed since save fired → mirror the patched body
        // back so the editor's local content reflects the fresh
        // `updated:` timestamp without a close-reopen reload.
        // `savedBodyRef.current` is set to the PATCHED body so the
        // subsequent body-change effect (when the parent calls
        // `setContent(patchedBody)`) sees `body === savedBodyRef.current`
        // → routes to the "revert to last-saved" clean branch (no
        // re-fire loop).
        savedBodyRef.current = patchedBody;
        dirtyRef.current = false;
        setStatus({ status: "saved", at: new Date() });
        // MYND-31: live re-index from the just-saved body (decrypt-free —
        // the body is already in V8). Best-effort, fire-and-forget so a
        // VaultIndices hiccup never affects the save status.
        void reindexNoteFromBody(id, patchedBody);
        if (onSaved !== undefined && patchedBody !== bodyAtFire) {
          onSaved(patchedBody);
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
            await onBaseMismatchRef.current(latestBodyRef.current);
            return;
          } catch {
            // fall through to the error state below
          }
        }
        dirtyRef.current = true;
        setStatus({ status: "error", error: err });
      } finally {
        inFlightRef.current = null;
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
      // User reverted to last-saved state — back to clean.
      dirtyRef.current = false;
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
      if (
        dirtyRef.current &&
        inFlightRef.current === null &&
        noteIdRef.current !== null
      ) {
        void saveImplRef
          .current(noteIdRef.current, latestBodyRef.current)
          .catch(() => {
            /* best-effort on unmount */
          });
      }
    };
    // Intentionally empty deps — runs only on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useMemo(
    () => ({ status, retry, flushIfDirty, acceptReloadedBody }),
    [status, retry, flushIfDirty, acceptReloadedBody],
  );
}
