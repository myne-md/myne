// Autosaving the open note (myne-md/myne#1037, owner report on 0.17.0).
//
// The phone had NO autosave: the buffer reached disk only on an exit or a
// backgrounding, so a note left open had nothing for sync to push and the user
// read that as "sync is slow". Same cadence as the desktop writer
// (`src/notes/saveNote.ts`): one idle timer, plus a ceiling so continuous typing
// still lands.

import { useEffect, useRef } from "react";

/** Idle delay after the last keystroke before the buffer is written. */
export const AUTOSAVE_IDLE_MS = 1000;
/** Longest a change may wait under continuous typing. */
export const AUTOSAVE_MAX_MS = 10_000;

/**
 * Call `persist` `AUTOSAVE_IDLE_MS` after `idleText` stops changing, and at most
 * `AUTOSAVE_MAX_MS` apart while it keeps changing.
 *
 * `idleText` is the buffer's current text: a keystroke changes it, which restarts
 * the idle timer. The persist function is held in a ref so the timers are not
 * rebuilt per keystroke, which would reset the idle window forever.
 */
export function useAutosave(
  idleText: string,
  enabled: boolean,
  persist: () => void | Promise<void>,
): void {
  const persistRef = useRef(persist);
  persistRef.current = persist;

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => {
      void persistRef.current();
    }, AUTOSAVE_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [idleText, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const interval = window.setInterval(() => {
      void persistRef.current();
    }, AUTOSAVE_MAX_MS);
    return () => window.clearInterval(interval);
  }, [enabled]);
}
