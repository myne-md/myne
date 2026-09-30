// The agent tab's conversation column (myne-md/myne#771): the open
// conversation, with the note it is about one click away.
//
// It was `AgentFocusView`, the second of two views you navigated between. There
// is one screen now — the history rail beside this column
// (`design-notes/ai/0627`) — so this is a COLUMN rather than a view, and the
// back control that used to head it is gone: there is nothing to go back to
// when the thing you would go back to is beside you.
//
// ── The note is a LINK rather than a pane, and stays one ────────────────────
// The design session asked for the split Ömer described: the note on one side,
// its conversation on the other. The literal reading is an automatic pane
// split, and that was rejected on the merits: `openToSide` on a note that is
// not already open moves the focused pane to the new leaf, so mounting this
// would silently steal focus from the tab the user just opened and rearrange a
// workspace they did not ask to rearrange. A hidden layout mutation on mount is
// worse than the thing it buys.
//
// So the note is one action away: a header link opens (or reveals) it beside
// whatever the user already has. A user who wants the split gets it
// deliberately, in one click, and their layout stays theirs.
//
// ── The conversation is the shared surface ──────────────────────────────────
// Same `ConversationSurface` the light panel uses, so a run started here and a
// run started in the panel are one implementation (story 23).

import { useCallback, useEffect, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../components/primitives/Button";
import { ConversationSurface } from "../ai/ConversationSurface";
import { openConversation } from "../ai/chatPersist";
import { useWorkspace } from "../workspaceContext";

const WRAP_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2)",
};

export interface AgentConversationViewProps {
  /** The note this conversation is anchored to, or `null` when it is about the
   *  vault rather than one note — a normal state, not a degraded one. */
  noteId: string | null;
  /** The conversation being continued, or `null` for a fresh one. */
  conversationId: string | null;
  /** Folders the composer can attach as a run scope. */
  folders?: readonly string[];
  /** Called with the ids of notes an apply wrote. */
  onNotesWritten?: (noteIds: readonly string[]) => void;
  /** Called after a run undo reverted notes on disk. */
  onRunUndone?: (noteIds: readonly string[]) => void;
}

export function AgentConversationView({
  noteId,
  conversationId,
  folders,
  onNotesWritten,
  onRunUndone,
}: AgentConversationViewProps) {
  const { t } = useTranslation();
  const ws = useWorkspace();

  // Open the conversation Focus is about, if a specific one was selected and is
  // not already the live transcript. `openConversation` is idempotent on the
  // active id, and the Hub already opened it before switching views, so this is
  // the reload-and-retry path rather than the common one.
  useEffect(() => {
    if (conversationId === null) return;
    // A failed reopen leaves the current transcript in place; the surface
    // already warns on a hydrate failure.
    void openConversation(conversationId).catch(() => undefined);
  }, [conversationId]);

  const openNote = useCallback(() => {
    if (noteId !== null && noteId !== "") ws.openInFocused(noteId);
  }, [ws, noteId]);

  return (
    <div data-testid="agent.focus" style={WRAP_STYLE}>
      <div style={HEADER_STYLE}>
        {noteId !== null && noteId !== "" ? (
          <Button
            type="button"
            variant="ghost"
            data-testid="agent.focus-open-note"
            data-note-id={noteId}
            onClick={openNote}
          >
            {t("agent.focus.openNote")}
          </Button>
        ) : null}
      </div>
      <ConversationSurface
        testId="agent.focus-surface"
        openNoteId={noteId}
        {...(folders === undefined ? {} : { folders })}
        {...(onNotesWritten === undefined ? {} : { onNotesWritten })}
        {...(onRunUndone === undefined ? {} : { onRunUndone })}
      />
    </div>
  );
}
