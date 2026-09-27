// The agent pane (myne-md/myne#771): the agent tab's body, mounted in the centre
// pane by `PaneView` the way `GraphPane` and `TasksPane` are.
//
// **Two views, one tab kind.** The `agent` tab is a singleton; its `agentView`
// field says whether it is showing the vault-general Hub (a conversation list)
// or Focus (one note beside its conversation). A view selector is not a second
// tab kind: `isSingletonTabKind("agent")` is true, so a second "open the agent"
// is a reveal of this one, and the view is the thing that tells the user which
// scope they are in.
//
// This file owns the view switch and the chrome common to both views, and it is
// the ONE place the view is written to the workspace (`setAgentViewState`), so a
// Hub row opening Focus and a palette verb opening Focus take the same path.

import { useCallback, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import type { PaneId } from "../workspaceState";
import type { WorkspaceItem } from "../workspaceState";
import { agentViewOf } from "../workspaceState";
import { useWorkspace } from "../workspaceContext";
import { AgentHubList } from "./AgentHubList";
import { AgentFocusView } from "./AgentFocusView";
import { AgentRunOrb } from "./AgentRunOrb";

const ROOT_STYLE: CSSProperties = {
  height: "100%",
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
  flexWrap: "wrap",
  rowGap: "var(--space-1)",
};

const HEADING_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  color: "var(--fg-2)",
};

export interface AgentPaneProps {
  /** The leaf pane this tab lives in, so a view change is written to the right
   *  workspace leaf (the `TasksPane` pattern). */
  paneId: PaneId;
  /** The `agent`-kind tab item. Typed as the whole `WorkspaceItem` union, the
   *  way `TasksPane` is: `PaneView` narrows by `kind` before mounting. */
  item: WorkspaceItem;
  /** Folders the composer can attach as a run scope. */
  folders?: readonly string[];
  /** Called with the ids of notes an apply wrote, so panes re-read them. */
  onNotesWritten?: (noteIds: readonly string[]) => void;
  /** Called after a run undo reverted notes on disk. */
  onRunUndone?: (noteIds: readonly string[]) => void;
}

export function AgentPane({
  paneId,
  item,
  folders,
  onNotesWritten,
  onRunUndone,
}: AgentPaneProps) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const view = agentViewOf(item);

  // One writer for the view, used by Hub rows and (through the palette verbs)
  // by anything that reveals the tab on a particular note.
  const openFocus = useCallback(
    (next: { noteId?: string | null; conversationId?: string | null }) => {
      const noteId = next.noteId ?? ws.focusedNoteId ?? null;
      if (noteId === null || noteId === "") return;
      ws.setAgentViewState(paneId, {
        view: "focus",
        noteId,
        ...(next.conversationId != null ? { conversationId: next.conversationId } : {}),
      });
    },
    [ws, paneId],
  );
  const backToHub = useCallback(
    () => ws.setAgentViewState(paneId, { view: "hub" }),
    [ws, paneId],
  );
  // The Hub's anchor chip opens the note in the workspace; the user reads the
  // conversation and the note it changed side by side.
  const openNote = useCallback(
    (noteId: string) => ws.openInFocused(noteId),
    [ws],
  );

  return (
    <div data-testid="agent.pane" data-agent-view={view.view} style={ROOT_STYLE}>
      <div style={HEADER_STYLE}>
        <div style={HEADING_STYLE}>
          {view.view === "hub" ? t("agent.hub.title") : t("agent.focus.title")}
        </div>
        {/* The run indicator: present only while a run is active, and it stops
            when the run stops (myne-md/myne#771, the named motion-canon
            exemption). Decorative: the state's meaning is in the surface text. */}
        <AgentRunOrb />
      </div>

      {view.view === "hub" ? (
        <AgentHubList
          onOpenFocus={openFocus}
          onOpenNote={openNote}
          {...(folders === undefined ? {} : { folders })}
          {...(onNotesWritten === undefined ? {} : { onNotesWritten })}
          {...(onRunUndone === undefined ? {} : { onRunUndone })}
        />
      ) : (
        <AgentFocusView
          noteId={view.noteId ?? null}
          conversationId={view.conversationId ?? null}
          onBackToHub={backToHub}
          {...(folders === undefined ? {} : { folders })}
          {...(onNotesWritten === undefined ? {} : { onNotesWritten })}
          {...(onRunUndone === undefined ? {} : { onRunUndone })}
        />
      )}
    </div>
  );
}
