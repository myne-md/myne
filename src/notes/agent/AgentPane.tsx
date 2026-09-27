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
import { useAgent } from "./agentStore";

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

/** The orb plus the word it means. They are one object, so they sit in one
 *  box: an indicator that can drift away from its own label is an indicator
 *  that can end up beside somebody else's. */
const RUN_LABEL_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontSize: "var(--text-xs)",
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
  // Whether a run is in flight, read here rather than inside the orb so the
  // pane can also state it in words and expose it to a scenario. The orb reads
  // the same store for itself, which is deliberate duplication: it must be
  // correct when mounted anywhere, not only where a caller remembered to pass
  // the fact in.
  const running = useAgent().running;

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
    <div
      data-testid="agent.pane"
      data-agent-view={view.view}
      // Observable to a scenario without reaching into the orb's own internals:
      // the pane knows whether a run is in flight, and that is the fact an E2E
      // wants to wait on.
      data-agent-running={running ? "true" : undefined}
      style={ROOT_STYLE}
    >
      <div style={HEADER_STYLE}>
        <div style={HEADING_STYLE}>
          {view.view === "hub" ? t("agent.hub.title") : t("agent.focus.title")}
        </div>
        {/* The run indicator: present only while a run is active, and it stops
            when the run stops (myne-md/myne#771, the named motion-canon
            exemption). Decorative and `aria-hidden` — which is only honest
            while the meaning is stated in WORDS beside it, so the label is part
            of the exemption rather than a caption on it. Without it the one
            thing reporting a multi-minute wait would be a 14px shape no screen
            reader ever reaches. */}
        {running ? (
          <span style={RUN_LABEL_STYLE} data-testid="agent.run-label">
            <AgentRunOrb />
            {t("agent.progress.working")}
          </span>
        ) : null}
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
