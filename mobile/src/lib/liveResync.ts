// The resync for a remote change the editor could not place (myne-md/myne#849).
//
// `./liveRemoteMerge.ts` maps a peer's change over the user's unsaved text and
// delivers it. When that fails (the screen does not know what the session holds,
// or the delivery throws), the session's own text is the truth and the buffer is
// rebuilt from it. What the buffer held that was never persisted exists nowhere
// else, because mobile has no SNAPSHOT history, so it is kept as a
// conflict copy FIRST and the buffer is replaced only after that copy exists.
//
// Extracted from the editor screen so a spec can drive every arm (the review
// that asked for it found the inline version reachable by no test tier).

/** What the resync needs from the screen and the note IO, all injected. */
export interface LiveResyncDeps {
  /** The note on screen now; a resync for any other note stops. */
  currentNoteId(): string | null;
  /** The session's text, or `null` when no session owns the note. */
  readSession(noteId: string): Promise<string | null>;
  /** The note's text on disk, for a session that closed meanwhile (closing flushes). */
  readDisk(noteId: string): Promise<string>;
  /** The buffer on screen, read when called. */
  buffer(): string;
  /** The text last persisted from this buffer, or `null` when unknown. */
  persisted(noteId: string): string | null;
  /** Write `text` as a conflict copy of `noteId`; resolves with the copy's id. */
  createCopy(text: string, noteId: string): Promise<string>;
  /** Overwrite an existing copy with newer text. */
  updateCopy(copyId: string, text: string): Promise<void>;
  /** Replace the buffer and the screen's record of what is persisted and in the session. */
  rebuild(noteId: string, text: string): void;
  /** Tell the user what happened. */
  report(outcome: LiveResyncOutcome, copyId?: string): void;
}

export type LiveResyncOutcome =
  /** Rebuilt; there was no unsaved text to keep. */
  | "reloaded"
  /** Rebuilt, and the unsaved text is in a conflict copy. */
  | "reloadedKept"
  /** Could not read the note; the buffer is untouched. */
  | "readFailed"
  /** Could not write the copy; the buffer is untouched so the text is not lost. */
  | "copyFailed";

/**
 * Run one resync for `noteId`. Never rejects: every failure leaves the buffer as
 * it was and is reported, which is the only outcome that cannot lose text.
 */
export async function runLiveResync(noteId: string, deps: LiveResyncDeps): Promise<LiveResyncOutcome | null> {
  let live: string;
  try {
    live = (await deps.readSession(noteId)) ?? (await deps.readDisk(noteId));
  } catch {
    deps.report("readFailed");
    return "readFailed";
  }
  if (deps.currentNoteId() !== noteId) return null;
  const snapshot = deps.buffer();
  const unsaved = snapshot !== live && deps.persisted(noteId) !== snapshot;
  let copyId: string | undefined;
  if (unsaved) {
    try {
      copyId = await deps.createCopy(snapshot, noteId);
      // The copy took several IPC hops, and the user may have kept typing. What
      // they typed in that window is in neither the copy nor the note, so the
      // copy is brought up to date before the buffer is replaced, and again for
      // whatever was typed during THAT write (myne-md/myne#849 review round 5),
      // until the buffer holds still across one write. Bounded: a user still
      // typing after a few rounds keeps their buffer and is told the copy failed.
      let written = snapshot;
      for (let round = 0; deps.buffer() !== written; round += 1) {
        if (round >= 4) throw new Error("buffer would not settle");
        const latest = deps.buffer();
        await deps.updateCopy(copyId, latest);
        written = latest;
      }
    } catch {
      deps.report("copyFailed");
      return "copyFailed";
    }
  }
  if (deps.currentNoteId() !== noteId) return null;
  // No await since the loop last found the buffer equal to the copy, so nothing
  // typed can fall between the copy's last write and the buffer's replacement.
  deps.rebuild(noteId, live);
  const outcome = unsaved ? "reloadedKept" : "reloaded";
  deps.report(outcome, copyId);
  return outcome;
}
