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
import { AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_MS, saveNote } from "./saveNote";
import { reindexNoteFromBody } from "./vaultIndices";

export type SaveStatus =
  | { status: "clean" }
  | { status: "editing" }
  | { status: "saving" }
  | { status: "saved"; at: Date }
  | { status: "error"; error: unknown };

export type UseAutosaveReturn = {
  status: SaveStatus;
  /** Re-fire the last save with the current body. Used by the Retry button. */
  retry: () => void;
  /** Flush any pending save synchronously (awaitable). No-op when clean. */
  flushIfDirty: () => Promise<void>;
};

/**
 * Test-injectable seam — swap `saveNote` for a mock in fake-timer tests.
 * The default points at the production helper. Return value is the
 * patched body (with the fresh `updated:` frontmatter timestamp); the
 * hook mirrors this back via the optional `onSaved` callback so the
 * editor's local state reflects the patch without close-reopen.
 */
export type SaveFn = (noteId: string, body: string) => Promise<string>;

const DEFAULT_SAVE_FN: SaveFn = saveNote;

export function useAutosave(
  noteId: string | null,
  body: string,
  saveImpl: SaveFn = DEFAULT_SAVE_FN,
  onSaved?: (patchedBody: string) => void,
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
        const patchedBody = await saveImpl(id, bodyAtFire);
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
        dirtyRef.current = true;
        setStatus({ status: "error", error: err });
      } finally {
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = promise;
    return promise;
  }, [clearTimers, saveImpl]);

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
    () => ({ status, retry, flushIfDirty }),
    [status, retry, flushIfDirty],
  );
}
