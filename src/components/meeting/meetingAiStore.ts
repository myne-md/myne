// Meeting AI offer store (meeting-ai task 4).
//
// The meeting session writes its note and then OFFERS the AI pass; the offer is
// a toast, and taking it must open a dialog that lives in the Editor's React
// tree. The session module is not React, so this tiny observable is the bridge:
// the session publishes the offer, the Editor subscribes and renders the
// dialog. Same shape as `toastStore`, deliberately small.

export interface MeetingAiOffer {
  noteId: string;
  transcript: string;
}

let current: MeetingAiOffer | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Publish an offer for `noteId` built from `transcript`. */
export function offerMeetingAi(noteId: string, transcript: string): void {
  current = { noteId, transcript };
  emit();
}

/** Clear the offer (dialog closed, or accepted). */
export function clearMeetingAiOffer(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function subscribeMeetingAi(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot for `useSyncExternalStore`. */
export function getMeetingAiOffer(): MeetingAiOffer | null {
  return current;
}
