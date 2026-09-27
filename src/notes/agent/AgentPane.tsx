// The agent pane (myne-md/myne#771): the agent tab's body, mounted in the centre
// pane by `PaneView` the way `GraphPane` and `TasksPane` are.
//
// **One screen, not two views** (`design-notes/ai/0623`). The history rail
// sits beside the open conversation, which is the shape every chat application
// has, and the reason it is universal is that the two are looked at together:
// you scan the list for the one you meant while reading the one you have.
//
// It was a Hub (a conversation list) that you navigated OUT of into a Focus
// view (one conversation), with a back control to return. That made reading
// your history and continuing it two places and a round trip, and the state it
// needed — a `view` discriminator — was a mode where the user only ever wanted
// a selection.
//
// The two-view behaviour survives as the NARROW arm and nothing else: below
// about 560px of pane the two columns cannot both be used, so the rail becomes
// a view you switch to. That is a responsive fallback, which is what it should
// always have been.
//
// This file owns the selection and is the ONE place it is written to the
// workspace (`setAgentViewState`), so a rail row, a palette verb and the
// panel's exit all take the same path.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import type { PaneId } from "../workspaceState";
import type { WorkspaceItem } from "../workspaceState";
import { agentViewOf } from "../workspaceState";
import { useWorkspace } from "../workspaceContext";
import { AgentHubList } from "./AgentHubList";
import { AgentConversationView } from "./AgentConversationView";
import { Button } from "../../components/primitives/Button";
import { AgentRunOrb } from "./AgentRunOrb";
import { useAgent } from "./agentStore";
import { startNewConversation } from "../ai/startNewConversation";

/**
 * The pane's own box.
 *
 * `PaneView` hands a tab body the full pane with no inset — correct for a note,
 * where the editor owns its own margins, and wrong for a surface built out of
 * controls: the heading sat flush against the tab strip and the rail's first
 * button touched the pane's left edge.
 *
 * The inset is ASYMMETRIC, and deliberately. Vertically it is `--space-4`,
 * because the header has a tab strip above it and the composer has a status
 * bar below. Horizontally it is `--space-1`: the pane is narrow before it is
 * anything else — the rail takes 248px of it and the conversation lives in
 * what remains — so side padding is width taken from the two columns that
 * need it, to separate them from edges the pane already has.
 */
const ROOT_STYLE: CSSProperties = {
  height: "100%",
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  padding: "var(--space-4) var(--space-1)",
  boxSizing: "border-box",
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
  /**
   * Whether the narrow arm is showing the rail instead of the conversation.
   *
   * Local state, not persisted: it is a fallback's transient, and writing it
   * to the workspace would mean a tab dragged to a wide pane remembering a
   * choice that no longer has a meaning there.
   */
  const [railOpen, setRailOpen] = useState(false);

  /**
   * Focus restoration across the hub↔focus change (task 13 of
   * myne-md/myne#771).
   *
   * The two views are different subtrees, so switching unmounts the control
   * that was focused and React gives focus back to `<body>` — the keyboard
   * user is standing outside the pane with the whole app behind them, and
   * their next Tab starts from the top of the document. That is the same
   * defect myne-md/myne#775 fixed on the ribbon's Escape path, one surface
   * over.
   *
   * The pane takes focus itself rather than guessing at a control: which
   * control is right differs per view and per state (an empty hub has no rows,
   * a focus view may have no note button), and a container that is focusable
   * and labelled is somewhere a reader can orient from. It is focused only
   * when the view CHANGES, never on first mount, or opening the tab would
   * steal the caret from whatever opened it.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  const lastKey = useRef(view.conversationId ?? "");
  useEffect(() => {
    const key = view.conversationId ?? "";
    if (lastKey.current === key) return;
    lastKey.current = key;
    rootRef.current?.focus();
  }, [view.conversationId]);

  /**
   * Open a conversation in the main column, or start a fresh one by passing
   * neither key.
   *
   * There is no early return any more, and its removal is the point. The old
   * one refused when no note was focused, because the only thing Focus could
   * be was a note's conversation — so with nothing open there was nowhere to
   * go. A conversation is its own subject now: a vault-general one is a normal
   * state, not a degraded one, and what still needs a note is SENDING, which
   * the composer already refuses on its own (`defaultGrantFor` returns `null`
   * and Send is disabled). Refusing to open the screen was solving that one
   * layer too early.
   */
  const openConversationInPane = useCallback(
    (next: { noteId?: string | null; conversationId?: string | null }) => {
      const noteId = next.noteId ?? null;
      ws.setAgentViewState(paneId, {
        ...(next.conversationId != null && next.conversationId !== ""
          ? { conversationId: next.conversationId }
          : {}),
        ...(noteId !== null && noteId !== "" ? { noteId } : {}),
      });
    },
    [ws, paneId],
  );

  /**
   * Start a fresh conversation, about the note the user has open if any.
   *
   * **Both halves.** It wrote the workspace state and nothing else, so the tab
   * forgot which conversation it was showing while the chat store went on
   * holding the previous transcript — the screen did not change, and the button
   * read as broken because it very nearly was. `startNewConversation` is the
   * panel's own sequence, shared: cancel the run host-side FIRST, then clear
   * the transcript and the store.
   */
  const newConversation = useCallback(() => {
    startNewConversation();
    openConversationInPane({ noteId: ws.focusedNoteId });
  }, [openConversationInPane, ws.focusedNoteId]);

  // The Hub's anchor chip opens the note in the workspace; the user reads the
  // conversation and the note it changed side by side.
  const openNote = useCallback(
    (noteId: string) => ws.openInFocused(noteId),
    [ws],
  );

  return (
    <div
      className="myne-agent"
      data-testid="agent.pane"
      // The rail's narrow-width state. At wide widths the CSS ignores it
      // entirely — both columns are up — so it is a fallback's state rather
      // than the layout's, and nothing above the container query reads it.
      data-rail={railOpen ? "open" : "closed"}
      // Observable to a scenario without reaching into the orb's own internals:
      // the pane knows whether a run is in flight, and that is the fact an E2E
      // wants to wait on.
      data-agent-running={running ? "true" : undefined}
      // Which conversation is open, for the same reason. Empty for a fresh one.
      data-agent-conversation={view.conversationId ?? ""}
      // `-1`: reachable programmatically for the restoration above, never a
      // Tab stop of its own. A container in the tab order is a stop that does
      // nothing, on every pass through the pane.
      ref={rootRef}
      tabIndex={-1}
      aria-label={t("agent.hub.title")}
      style={ROOT_STYLE}
    >
      <div style={HEADER_STYLE}>
        <div style={HEADING_STYLE}>
          {/* The rail toggle, visible only in the narrow arm (the CSS decides,
              not this file). It is rendered unconditionally so the header does
              not reflow when a pane is dragged across the threshold. */}
          <Button
            variant="ghost"
            icon={railOpen ? "message-square" : "list"}
            className="myne-agent__rail-toggle"
            onClick={() => setRailOpen((open) => !open)}
            aria-expanded={railOpen}
            data-testid="agent.rail-toggle"
          >
            {railOpen ? t("agent.focus.title") : t("agent.hub.historyLabel")}
          </Button>
          {t("agent.hub.title")}
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

      <div className="myne-agent__body">
        <div className="myne-agent__rail" data-testid="agent.rail">
          <AgentHubList
            activeConversationId={view.conversationId ?? null}
            onOpenFocus={(next) => {
              openConversationInPane(next);
              // Narrow arm only: opening a conversation from the rail should
              // show it. At wide widths this changes nothing, because the CSS
              // never reads the attribute there.
              setRailOpen(false);
            }}
            onNewConversation={() => {
              newConversation();
              setRailOpen(false);
            }}
            onOpenNote={openNote}
          />
        </div>

        <div className="myne-agent__main">
          <AgentConversationView
            noteId={view.noteId ?? null}
            conversationId={view.conversationId ?? null}
            {...(folders === undefined ? {} : { folders })}
            {...(onNotesWritten === undefined ? {} : { onNotesWritten })}
            {...(onRunUndone === undefined ? {} : { onRunUndone })}
          />
        </div>
      </div>
    </div>
  );
}
