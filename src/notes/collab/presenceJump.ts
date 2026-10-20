// The roster's click-to-jump bridge (`collab-presence-ui` task 4).
//
// The "Who's here" tab lives in the right panel; the editor view lives in a pane.
// A row click asks the pane showing that note to scroll to the participant's last
// known caret. A DOM CustomEvent keeps the two decoupled (the `myne-open-tag`
// precedent): the tab dispatches, the pane whose active note matches listens.
// Jump only, there is no follow mode (decisions/ui/0659).

import type { Participant } from "./participant";

/** The event the roster fires; the pane listens for it. */
export const PRESENCE_JUMP_EVENT = "myne-presence-jump";

export interface PresenceJumpDetail {
  /** The note to jump within (the pane's own note id form). */
  noteId: string;
  /** The character offset to reveal, in UTF-16 code units from the document start
   *  (what the editor reports). */
  offset: number;
}

/** Ask the pane showing `noteId` to scroll to `participant`'s caret (or selection
 *  head). A participant with NEITHER has nothing to reveal and is a no-op: the old
 *  fallback scrolled to the top of the note, a real cost on a phone paid for a
 *  position the frame never carried. Here rather than at each roster's row, so the
 *  desktop tab and the mobile sheet cannot disagree (myne-md/myne#849 review). */
export function requestPresenceJump(noteId: string | null, participant: Participant): void {
  if (noteId === null) return;
  const offset = participant.caret ?? participant.selection?.head ?? null;
  if (offset === null) return;
  window.dispatchEvent(
    new CustomEvent<PresenceJumpDetail>(PRESENCE_JUMP_EVENT, {
      detail: { noteId, offset },
    }),
  );
}

// The roster's jump TARGET, shared by the desktop pane and the mobile screen
// (myne-md/myne#849 review). The two used to compute it separately and agree by
// hand, which is how one defect (the reveal comparing a line PREFIX) had to be
// fixed twice.
//
// The target is clamped rather than trusted: the offset comes from a peer's frame,
// so it describes that peer's document and not necessarily ours. Two devices
// editing one note are converged but need not be byte-identical at any instant, and
// a line number past the document is a scroll to nowhere.

/** What the shared editor consumes as `revealLine`. */
export interface PresenceReveal {
  noteId: string;
  /** 0-based line index, clamped to the document. */
  line: number;
  /**
   * The line's WHOLE text, trimmed, because that is what the consumer compares it
   * to (`editor/src/CMEditor.tsx`: `doc.line(n).text.trim() === target`).
   *
   * The first version emitted the line's PREFIX up to the caret, which equals the
   * line only when the caret sits at its end, so for the ordinary case (a peer
   * mid-word) the comparison failed, the editor marked the nonce applied, and the
   * roster's jump was a silent no-op (myne-md/myne#849 review). The desktop pane
   * computed the same prefix inline and had the same defect; both emit the line now.
   */
  text: string;
  /** Bumped per reveal so a repeat jump to the same line acts again. */
  nonce: number;
}

/**
 * Derive the reveal for `offset` in `text`.
 *
 * `now` is passed in rather than read, so the nonce is deterministic under test.
 */
export function presenceRevealFor(
  noteId: string,
  text: string,
  offset: number,
  now: number,
): PresenceReveal {
  // The CLAMP is the load-bearing half, and `slice` does its own index
  // truncation, so a `Math.trunc` here was redundant (myne-md/myne#849 review found
  // it by trying to write a test that would fail without it and discovering none
  // could: every input that would distinguish them clamps to the same value first).
  const at = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, at);
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEnd = text.indexOf("\n", lineStart);
  return {
    noteId,
    line: before.split("\n").length - 1,
    text: text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim(),
    nonce: now,
  };
}
