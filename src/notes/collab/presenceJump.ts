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
 *  head). A participant with neither lands at the top. */
export function requestPresenceJump(noteId: string | null, participant: Participant): void {
  if (noteId === null) return;
  const offset = participant.caret ?? participant.selection?.head ?? 0;
  window.dispatchEvent(
    new CustomEvent<PresenceJumpDetail>(PRESENCE_JUMP_EVENT, {
      detail: { noteId, offset },
    }),
  );
}
