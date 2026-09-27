// The agent Hub: the vault-general conversation list (myne-md/myne#771 task 3).
//
// ── What this is ────────────────────────────────────────────────────────────
// The Hub is the agent tab's default view and the half that "sees all of the sub
// past ones": every conversation in the vault, note-anchored ones included, newest
// first. It is a list you dwell in, which is why it is a tab view rather than a
// modal (`polish-epic-prompt.md` D3).
//
// ── Data ────────────────────────────────────────────────────────────────────
// `chatsList` returns the catalog roster; the row carries its id at the read
// boundary. Opening a row binds the transcript to it (`openConversation`);
// rename and delete are catalog mutations. The list re-fetches after every
// mutation rather than patching locally, so a sync arrival is never missed and
// the row order stays the backend's.
//
// ── The empty states are DISTINCT, which is the point of the slice ───────────
// A filtered-to-nothing list is not an empty vault, and a vault with no
// conversations is not a broken provider. The first-run state offers a first
// action; the no-provider state says what to fix. Search/filter arrives in task 5
// and adds the third variant.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { useDateTimeDisplay } from "../../lib/useDateTimeDisplay";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { Input } from "../../components/primitives/Input";
import { Tooltip } from "../../components/primitives/Tooltip";
import { EmptyState } from "../../components/primitives/EmptyState";
import {
  chatsDelete,
  chatsList,
  chatsRename,
  type ConversationListRow,
} from "../../lib/chats";
import { clearChatPersistForLock, openConversation } from "../ai/chatPersist";
import { discardChat, getActiveConversationId } from "../ai/chatStore";

/** Newest first: the list order, applied to every fetch path. */
function byUpdatedDesc(rows: ConversationListRow[]): ConversationListRow[] {
  return [...rows].sort((a, b) => b.updated_at - a.updated_at);
}

function relativeDay(updatedAt: number, locale: string, timeZone: string | null): string {
  const date = new Date(updatedAt);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    ...(timeZone === null ? {} : { timeZone }),
  });
}

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-2)",
  borderRadius: "var(--radius-1)",
  border: "1px solid var(--line-1)",
  textAlign: "left",
};

const TITLE_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "none",
  border: "none",
  padding: 0,
  textAlign: "left",
  cursor: "pointer",
};

const META_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  whiteSpace: "nowrap",
};

const ERROR_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
  margin: 0,
};

const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  overflowY: "auto",
  minHeight: 0,
  flex: 1,
};


export interface AgentHubListProps {
  /** Open an existing conversation in the main column. The pane owns the
   *  workspace write, so the rail does not reach into it. */
  onOpenFocus: (next: { conversationId?: string }) => void;
  /** Start a fresh conversation. Separate from `onOpenFocus` because they are
   *  different acts: one selects, the other creates, and collapsing them into
   *  "open with no id" is how a New-chat button ends up reopening the last one. */
  onNewConversation?: () => void;
  /** The conversation currently in the main column, so the rail can mark it.
   *  Read from the WORKSPACE rather than from the chat store: the store's
   *  active id is the live transcript, which lags a selection by a round trip
   *  and would leave the rail highlighting the previous row mid-switch. */
  activeConversationId?: string | null;
  /** Open the note a conversation is anchored to, in the workspace. */
  onOpenNote?: (noteId: string) => void;
  /** Folders the composer can attach as a run scope (passed through to Focus). */
  folders?: readonly string[];
  /** Called with the ids of notes an apply wrote, so panes re-read them. */
  onNotesWritten?: (noteIds: readonly string[]) => void;
  /** Called after a run undo reverted notes on disk. */
  onRunUndone?: (noteIds: readonly string[]) => void;
}

export function AgentHubList({
  onOpenFocus,
  onNewConversation,
  activeConversationId = null,
  onOpenNote,
}: AgentHubListProps) {
  const { t } = useTranslation();
  const { locale, timeZone } = useDateTimeDisplay();
  const [rows, setRows] = useState<ConversationListRow[] | null>(null);
  const [error, setError] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /**
   * What just happened, announced (task 13 of myne-md/myne#771).
   *
   * Rename, delete and a failed reload all change the list WITHOUT moving
   * focus, so a screen-reader user pressed a button and heard nothing: the row
   * they were on either changed name underneath them or stopped existing. A
   * live region is the only channel that reports a change the user did not
   * navigate to.
   *
   * Cleared on the next interaction rather than on a timer: a message that
   * erases itself races the reader that is announcing it.
   */
  const [announcement, setAnnouncement] = useState("");
  // The workspace's selection when the pane supplies one, the live transcript
  // otherwise (the light panel mounts this list with neither).
  const activeId = activeConversationId ?? getActiveConversationId();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setRows(byUpdatedDesc(await chatsList()));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void chatsList().then(
      (list) => {
        if (!cancelled) setRows(byUpdatedDesc(list));
      },
      () => {
        if (!cancelled) setError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpen = useCallback(
    async (id: string): Promise<void> => {
      if (id !== getActiveConversationId()) {
        const outcome = await openConversation(id);
        if (outcome !== "opened") {
          setError(true);
          return;
        }
      }
      // Opening a row moves the tab to Focus on that conversation.
      onOpenFocus({ conversationId: id });
    },
    [onOpenFocus],
  );

  const commitRename = useCallback(
    async (id: string): Promise<void> => {
      const title = draft.trim();
      if (title.length === 0) {
        setRenamingId(null);
        return;
      }
      try {
        await chatsRename(id, title);
        setRenamingId(null);
        setAnnouncement(t("agent.hub.renamedAnnouncement", { name: draft.trim() }));
        await refresh();
      } catch {
        setError(true);
      }
    },
    [draft, refresh, t],
  );

  const commitDelete = useCallback(
    async (id: string): Promise<void> => {
      try {
        await chatsDelete(id);
        // Only the open transcript dies with its conversation, and it dies
        // WITHOUT a persist: the turns are deleted by intent.
        if (getActiveConversationId() === id) {
          discardChat();
          clearChatPersistForLock();
        }
        setDeletingId(null);
        setAnnouncement(t("agent.hub.deletedAnnouncement"));
        await refresh();
      } catch {
        setError(true);
      }
    },
    [refresh, t],
  );

  if (error) {
    return (
      <p data-testid="agent.hub-error" style={ERROR_STYLE}>
        {t("agent.hub.loadFailed")}
      </p>
    );
  }
  if (rows === null) {
    return (
      <p data-testid="agent.hub-loading" style={META_STYLE}>
        {t("agent.hub.loading")}
      </p>
    );
  }
  if (rows.length === 0) {
    // First-run: explain what the agent is and OFFER THE FIRST ACTION. It did
    // not, for a round, and that is the exact dead end `<EmptyState>` exists to
    // prevent — a `firstRun` state whose whole job is to offer the thing that
    // creates the first thing. `<PanelEmptyState>` cannot carry an action at
    // all, so using it here meant a screen that explained what conversations
    // are and gave the user no way to have one.
    //
    // The action is conditional because the capability is: a run needs a scope,
    // and with no note open there is none the host would accept. So the two
    // situations get two different bodies rather than one button that works
    // sometimes.
    return (
      <EmptyState
        variant="firstRun"
        icon="message-square"
        size="sm"
        title={t("agent.hub.emptyTitle")}
        body={t("agent.hub.emptyBody")}
        testId="agent.hub-empty"
        action={
          onNewConversation === undefined ? undefined : (
            <Button
              variant="primary"
              icon="plus"
              onClick={onNewConversation}
              data-testid="agent.hub-new"
            >
              {t("agent.hub.newConversation")}
            </Button>
          )
        }
      />
    );
  }

  // Filter by title, case-insensitively. Server-side search is not this slice:
  // the catalog is small and already in memory. Computed AFTER the null and
  // empty returns, so `rows` is narrowed to a real array.
  const q = query.trim().toLowerCase();
  const visible =
    q.length === 0 ? rows : rows.filter((r) => r.title.toLowerCase().includes(q));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", flex: 1, minHeight: 0 }}>
      {/* The announcement channel. `polite` rather than `assertive`: these are
          confirmations of something the user just did, not interruptions.
          Always MOUNTED, never conditionally rendered — a live region that
          appears at the same moment its text does is a region most readers
          never announce, because they were not watching an element that did
          not exist. */}
      <span
        role="status"
        aria-live="polite"
        data-testid="agent.hub-announcer"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        {announcement}
      </span>
      {/* Start a new one, above the list. Without this the Hub is a surface you
          can only ever CONTINUE from: the empty state's action disappears the
          moment there is one conversation, and a user with a single old chat
          would have no way to begin a second from here.

          Conditional on a note being open for the same reason the empty
          state's action is: a run needs a scope the host will accept, and with
          no note open there is none. */}
      {/* New chat, unconditional. It was gated on a note being open, because
          starting one meant opening a view that needed a scope; a conversation
          is its own subject now, and what still needs a note is SENDING, which
          the composer refuses on its own. Gating the button here refused the
          screen one layer too early. */}
      {onNewConversation !== undefined && (
        <Button
          variant="secondary"
          icon="plus"
          onClick={onNewConversation}
          data-testid="agent.hub-new"
        >
          {t("agent.hub.newConversation")}
        </Button>
      )}
      <Input
        type="search"
        data-testid="agent.hub-search"
        aria-label={t("agent.hub.searchLabel")}
        placeholder={t("agent.hub.searchPlaceholder")}
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
      />
      {visible.length === 0 ? (
        // A filtered-to-nothing list is NOT an empty vault: it echoes the query
        // and offers the way back. `<PanelEmptyState>` cannot say that — it is
        // hardwired to `firstRun`, which is the whole distinction this variant
        // exists to draw, and the comment here claimed the filtered variant
        // while rendering the other one. Straight to `<EmptyState>`, with the
        // query echoed through the prop that bidi-isolates it.
        <EmptyState
          variant="filtered"
          icon="search"
          size="sm"
          title={t("agent.hub.noMatchTitle")}
          body={t("agent.hub.noMatchBody", { query: "" }).trim()}
          query={query.trim()}
          testId="agent.hub-no-match"
          action={
            <Button variant="secondary" icon="x" onClick={() => setQuery("")}>
              {t("attachments.library.emptyClearSearch")}
            </Button>
          }
        />
      ) : (
    <div data-testid="agent.hub-list" style={LIST_STYLE}>
      {visible.map((row) => (
        <div key={row.id} data-testid="agent.hub-row" data-conversation-id={row.id}>
          {deletingId === row.id ? (
            <div style={{ ...ROW_STYLE, flexDirection: "column", alignItems: "stretch" }}>
              <p style={{ ...ERROR_STYLE, color: "var(--fg-1)", margin: 0, fontWeight: "var(--weight-medium)" }}>
                {t("editor.chrome.rightPanel.aiChat.historyDeleteTitle")}
              </p>
              <p style={{ ...ERROR_STYLE, color: "var(--fg-1)", margin: 0 }}>
                {t("editor.chrome.rightPanel.aiChat.historyDeleteBody")}
              </p>
              <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
                <Button
                  type="button"
                  variant="ghost"
                  data-testid="agent.hub-delete-cancel"
                  onClick={() => setDeletingId(null)}
                >
                  {t("editor.chrome.rightPanel.aiChat.historyCancel")}
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  data-testid="agent.hub-delete-confirm"
                  onClick={() => void commitDelete(row.id)}
                >
                  {t("editor.chrome.rightPanel.aiChat.historyDelete")}
                </Button>
              </div>
            </div>
          ) : renamingId === row.id ? (
            <div style={ROW_STYLE}>
              <Input
                data-testid="agent.hub-rename-input"
                aria-label={t("editor.chrome.rightPanel.aiChat.historyRename")}
                value={draft}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitRename(row.id);
                  if (e.key === "Escape") setRenamingId(null);
                }}
              />
              <Button
                type="button"
                variant="secondary"
                data-testid="agent.hub-rename-confirm"
                onClick={() => void commitRename(row.id)}
              >
                {t("editor.chrome.rightPanel.aiChat.historyRename")}
              </Button>
            </div>
          ) : (
            <div
              style={ROW_STYLE}
              data-active={row.id === activeId ? "true" : "false"}
              // The conversation currently open in the surface. `aria-current`
              // is what carries that to a reader; `data-active` paints it and
              // carries nothing. They were one attribute doing one of the two
              // jobs.
              aria-current={row.id === activeId ? "true" : undefined}
            >
              {/* The row's own label ellipsizes, so the full title has to be
                  reachable somewhere — through `<Tooltip>` rather than the
                  native attribute, which waits ~1s, ignores the theme, clips at
                  the window edge and never appears on keyboard focus
                  (`scripts/check-tooltip-convention.mjs`). The button keeps its
                  text as its accessible name; the tooltip is visual only. */}
              {/* The row's title is the row's PRIMARY target, so it stays a
                  plain button with a text style rather than becoming a
                  `<Button>`: a ghost button's padding and hover fill would turn
                  a list of titles into a list of chips. Recorded rather than
                  converted, which is what `check-primitive-adoption.mjs` asks
                  for when an element genuinely is not a primitive. */}
              <Tooltip label={row.title}>
                <button
                  type="button"
                  data-testid="agent.hub-open"
                  onClick={() => void handleOpen(row.id)}
                  style={TITLE_STYLE}
                >
                  {row.title}
                </button>
              </Tooltip>
              {/* The note the conversation is anchored to, when it is
                  (myne-md/myne#771 story 10). This is what makes "on this
                  note" legible in the Hub, distinct from a vault-general
                  conversation. */}
              {row.note_id !== undefined ? (
                // A chiplet, not a hand-rolled button: the border, radius and
                // padding it was re-deriving are `.myne-chiplet`'s, and an app
                // that is supposed to have one chip design had two. The native
                // `title` it carried repeated its own visible label, which is
                // the one tooltip that says nothing.
                <button
                  type="button"
                  className="myne-chiplet"
                  data-testid="agent.hub-anchor"
                  data-note-id={row.note_id}
                  disabled={onOpenNote === undefined}
                  onClick={() => onOpenNote?.(row.note_id!)}
                >
                  <Icon name="file-text" size={12} />
                  {t("agent.hub.anchorLabel")}
                </button>
              ) : null}
              <span style={META_STYLE}>{relativeDay(row.updated_at, locale, timeZone)}</span>
              <Button
                type="button"
                variant="ghost"
                data-testid="agent.hub-rename"
                aria-label={t("editor.chrome.rightPanel.aiChat.historyRename")}
                onClick={() => {
                  setDeletingId(null);
                  setDraft(row.title);
                  setRenamingId(row.id);
                }}
              >
                {t("editor.chrome.rightPanel.aiChat.historyRename")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                data-testid="agent.hub-delete"
                aria-label={t("editor.chrome.rightPanel.aiChat.historyDelete")}
                onClick={() => {
                  setRenamingId(null);
                  setDeletingId(row.id);
                }}
              >
                {t("editor.chrome.rightPanel.aiChat.historyDelete")}
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
      )}
    </div>
  );
}
