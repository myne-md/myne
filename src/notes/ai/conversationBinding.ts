// The AI panel's conversation binding, held OUTSIDE the component
// (myne-md/myne#913, review round two).
//
// ── Why this is not `useState` ────────────────────────────────────────────
// The panel is mounted only while the right-hand tab is the AI one, so a tab
// switch unmounts it. Both facts this module holds were `useState`/`useRef` in
// the component first, which made them die on that unmount:
//
//  - the **pin** (`keepConversation`) silently reset, so a conversation the user
//    had explicitly pinned was cleared by the next note switch, which is exactly
//    what the pin exists to prevent;
//  - the **deferred switch** (a note change recorded while a run was in flight)
//    was dropped, so switching notes during a run left the old transcript beside
//    the new note, the defect the note binding exists to remove.
//
// Module state is the level that matches the promise: both are SESSION scoped
// (see `design-notes/ai/0719`), and the session outlives a tab switch. The
// vault does not: `resetConversationBinding()` runs on lock teardown, so a
// pinned conversation does not survive into the next unlock.

let pinned = false;
let pendingSwitch = false;
let conversationNote: string | null = null;

/** Whether the user has pinned this conversation across note switches. */
export function keepConversationPinned(): boolean {
  return pinned;
}

/** Pin or unpin, for the rest of the session. */
export function setKeepConversationPinned(next: boolean): void {
  pinned = next;
}

/** The note the open conversation belongs to.
 *
 *  **Held here for the same reason as the pin** (myne-md/myne#913, review round
 *  three): the panel unmounts on a tab switch, and a component-local ref meant a
 *  remount at note B adopted B as the conversation's note, so a conversation
 *  started on A continued under B, which is the defect the binding exists to
 *  remove. Module state survives the unmount; the lock drops it. */
export function conversationNoteId(): string | null {
  return conversationNote;
}

/** Bind the open conversation to a note (or to none). */
export function setConversationNote(noteId: string | null): void {
  conversationNote = noteId;
}

/** Record that a note change asked for a fresh conversation while a run was in
 *  flight. Applied when the run settles; see the settle effect in `AiChatTab`. */
export function requestNoteSwitch(): void {
  pendingSwitch = true;
}

/** Take the pending switch, clearing it. **Taking is how it is applied**: a
 *  granted switch must not be able to fire a second time on a later settle. */
export function takeNoteSwitch(): boolean {
  const value = pendingSwitch;
  pendingSwitch = false;
  return value;
}

/** Lock teardown: neither fact is vault content, and neither should follow the
 *  user into the next unlock. */
export function resetConversationBinding(): void {
  pinned = false;
  pendingSwitch = false;
  conversationNote = null;
}
