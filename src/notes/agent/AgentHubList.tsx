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
import { IconButton } from "../../components/primitives/IconButton";
import { Input } from "../../components/primitives/Input";
import { Tooltip } from "../../components/primitives/Tooltip";
import { EmptyState } from "../../components/primitives/EmptyState";
import {
  chatsDelete,
  chatsList,
  chatsRename,
  subscribeConversationRoster,
  type ConversationListRow,
} from "../../lib/chats";
import { clearChatPersistForLock, openConversation } from "../ai/chatPersist";
import { discardChat, getActiveConversationId } from "../ai/chatStore";

/** Newest first: the list order, applied to every fetch path. */
function byUpdatedDesc(rows: ConversationListRow[]): ConversationListRow[] {
  return [...rows].sort((a, b) => b.updated_at - a.updated_at);
}

function relativeDay(
  updatedAt: number,
  locale: string,
  timeZone: string | null,
): string {
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

/**
 * A rail row: the title on one line, its meta and actions on the next.
 *
 * It was ONE line holding a title, an anchor pill, a date and two text buttons
 * ("Rename", "Delete"). At the rail's 248px that is far more than fits, and
 * because `LIST_STYLE` sets `overflow-y: auto` — which per spec computes
 * `overflow-x` to `auto` as well — the whole list scrolled SIDEWAYS. The user
 * saw rows shifted half out of view with a horizontal scrollbar under them.
 *
 * Two lines is what a 248px column can hold. The list also pins
 * `overflow-x: hidden` now, so a future row that outgrows it truncates rather
 * than reintroducing the scroll.
 */
const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  gap: "var(--space-1)",
  padding: "var(--space-2)",
  borderRadius: "var(--radius-2)",
  border: "1px solid var(--line-1)",
  textAlign: "left",
  minWidth: 0,
};

/** The title line: the label, and the actions that act on it. */
const ROW_TOP_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  minWidth: 0,
};

/** The meta line: what it is about, and when it was last used. */
const ROW_META_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  minWidth: 0,
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

/**
 * The row's two actions, pushed to the far edge.
 *
 * `TITLE_STYLE` already carries `flex: 1`, and it was not enough: the title
 * button is wrapped in a `<Tooltip>`, so the FLEX ITEM is the tooltip's
 * wrapper and the `flex: 1` sits on a child of it, where the row's free space
 * never reaches. The result is the actions hugging the end of the title —
 * "hi ✏🗑" — so the two controls land in a different place on every row and
 * a column of them reads as ragged rather than as a column.
 *
 * `margin-inline-start: auto` is the fix rather than fixing the title's flex,
 * because it holds however the title is wrapped: a tooltip, a badge, a second
 * label later. `flex: none` so the pair never shrinks into each other on a
 * narrow rail — the title is what ellipsizes.
 */
const ROW_ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  flex: "none",
  marginInlineStart: "auto",
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

/** The rail's two non-list controls, on one row. */
const RAIL_HEADER_STYLE: CSSProperties = {
  display: "flex",
  // `stretch`, not `center`: the input and the button compute their heights
  // from different padding tokens, so centring left them a few pixels apart.
  // Stretching gives both the row's height; the button keeps its glyph centred
  // because it is itself an inline-flex with `align-items: center`.
  alignItems: "stretch",
  gap: "var(--space-1)",
  minWidth: 0,
};

const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  overflowY: "auto",
  // Explicit, and load-bearing: setting `overflow-y` alone computes
  // `overflow-x` to `auto` rather than leaving it `visible`, so a row wider
  // than the rail gave the whole list a horizontal scrollbar. A history rail
  // that scrolls sideways is a history rail nobody can read at a glance.
  overflowX: "hidden",
  minHeight: 0,
  minWidth: 0,
  flex: 1,
};

export interface AgentHubListProps {
  /** Open an existing conversation in the main column, carrying the note it is
   *  anchored to. The pane owns the workspace write, so the rail does not reach
   *  into it. */
  onOpenFocus: (next: {
    conversationId?: string;
    noteId?: string | null;
  }) => void;
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

  // Load once, then follow the roster.
  //
  // **The subscription is the half that was missing.** This list loaded on
  // mount and nothing told it anything afterwards, so a conversation created by
  // SENDING a message did not appear in the rail beside the reply that created
  // it — the user watched an answer arrive into a history that claimed there
  // was nothing there. It came back on the next mount, which made it look like
  // a refresh problem rather than a missing wire.
  //
  // `subscribeConversationRoster` fires from the three chats wrappers
  // themselves, so a future write site cannot forget to announce: the
  // announcement is in the path, not beside it.
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void chatsList().then(
        (list) => {
          if (!cancelled) setRows(byUpdatedDesc(list));
        },
        () => {
          if (!cancelled) setError(true);
        },
      );
    };
    load();
    const unsubscribe = subscribeConversationRoster(load);
    return () => {
      cancelled = true;
      unsubscribe();
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
      // **With the note it is anchored to.** It opened by id alone, so the
      // anchor was dropped on the way in: a conversation whose every turn says
      // "Working on: This note" came back with no scope at all, and the
      // composer asked the user to choose a folder for a conversation that had
      // been about a note the whole time. The row already knows — `note_id` is
      // on the catalog row and is why the anchor chip renders beside it.
      const row = (rows ?? []).find((r) => r.id === id);
      onOpenFocus({ conversationId: id, noteId: row?.note_id ?? null });
    },
    [onOpenFocus, rows],
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
        setAnnouncement(
          t("agent.hub.renamedAnnouncement", { name: draft.trim() }),
        );
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
  // Filter by title, case-insensitively. Server-side search is not this slice:
  // the catalog is small and already in memory. Computed AFTER the null and
  // empty returns, so `rows` is narrowed to a real array.
  const q = query.trim().toLowerCase();
  const visible =
    q.length === 0
      ? rows
      : rows.filter((r) => r.title.toLowerCase().includes(q));

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        flex: 1,
        minHeight: 0,
      }}
    >
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
      {/* **The search and New chat share a row.** They were stacked, which in a
          248px rail spent two full rows on the two controls that are not the
          list — and the list is what the rail is for.

          New chat is icon-only and ACCENT: it is the one thing on this surface
          that creates something, and everything else here opens, renames or
          deletes what already exists. It was gated on a note being open, which
          was right while starting a conversation meant opening a view that
          needed a scope; a conversation is its own subject now, and what still
          needs a note is SENDING, which the composer refuses on its own.

          `<Button variant="primary" icon>` rather than `<IconButton>`: the
          primitive has no accent arm, and it is the fill that carries "this is
          the one that makes something". Its label is the tooltip AND the
          accessible name, per the epic's convention — an icon-only control
          with no name is a guess. */}
      <div style={RAIL_HEADER_STYLE}>
        <Input
          type="search"
          data-testid="agent.hub-search"
          aria-label={t("agent.hub.searchLabel")}
          placeholder={t("agent.hub.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // `--radius-2`, the button's, rather than the input default
          // `--radius-1`: in this row the two controls sit flush beside each
          // other at the same height, and two corner radii a few pixels apart
          // read as a mismatch rather than as two kinds of control.
          style={{ flex: 1, minWidth: 0, borderRadius: "var(--radius-2)" }}
        />
        {onNewConversation !== undefined && (
          <Tooltip label={t("agent.hub.newConversation")}>
            <Button
              variant="primary"
              icon="plus"
              aria-label={t("agent.hub.newConversation")}
              data-testid="agent.hub-new"
              onClick={onNewConversation}
              style={{ flex: "none" }}
            />
          </Tooltip>
        )}
      </div>

      {rows.length === 0 ? (
        // First run: nothing to list yet. A QUIET line under the header, not a
        // card with its own button (docs/decisions/ui/0630). The header above
        // already carries the one action that creates a conversation, and the
        // conversation beside this rail carries the zero state that explains
        // what the agent is — a second bordered card with a second "New
        // conversation" button, side by side with the first, is what made the
        // empty agent tab look assembled rather than designed.
        //
        // No wash: the conversation's zero state carries it, and two washes a
        // hairline apart compete instead of framing anything.
        <EmptyState
          variant="firstRun"
          icon="message-square"
          size="sm"
          fill
          field={false}
          title={t("agent.hub.emptyTitle")}
          body={t("agent.hub.emptyBody")}
          testId="agent.hub-empty"
        />
      ) : visible.length === 0 ? (
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
            <div
              key={row.id}
              data-testid="agent.hub-row"
              data-conversation-id={row.id}
            >
              {deletingId === row.id ? (
                <div
                  style={{
                    ...ROW_STYLE,
                    flexDirection: "column",
                    alignItems: "stretch",
                  }}
                >
                  <p
                    style={{
                      ...ERROR_STYLE,
                      color: "var(--fg-1)",
                      margin: 0,
                      fontWeight: "var(--weight-medium)",
                    }}
                  >
                    {t("editor.chrome.rightPanel.aiChat.historyDeleteTitle")}
                  </p>
                  <p
                    style={{ ...ERROR_STYLE, color: "var(--fg-1)", margin: 0 }}
                  >
                    {t("editor.chrome.rightPanel.aiChat.historyDeleteBody")}
                  </p>
                  <div
                    style={{
                      display: "flex",
                      gap: "var(--space-2)",
                      justifyContent: "flex-end",
                    }}
                  >
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
                    aria-label={t(
                      "editor.chrome.rightPanel.aiChat.historyRename",
                    )}
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
                  <div style={ROW_TOP_STYLE}>
                    {/* The row's own label ellipsizes, so the full title has to be
                    reachable somewhere — through `<Tooltip>` rather than the
                    native attribute, which waits ~1s, ignores the theme, clips
                    at the window edge and never appears on keyboard focus
                    (`scripts/check-tooltip-convention.mjs`). The button keeps
                    its text as its accessible name; the tooltip is visual only.

                    Its title is the row's PRIMARY target, so it stays a plain
                    button with a text style rather than becoming a `<Button>`:
                    a ghost button's padding and hover fill would turn a list of
                    titles into a list of chips. Recorded rather than converted,
                    which is what `check-primitive-adoption.mjs` asks for when
                    an element genuinely is not a primitive. */}
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
                    {/* Icon-only, and that is what makes the row fit: "Rename" and
                    "Delete" as words are most of a 248px rail on their own,
                    which is how the list came to scroll sideways. They carry
                    their labels as tooltips and as accessible names, per the
                    epic's tooltip convention. */}
                    <div style={ROW_ACTIONS_STYLE} data-testid="agent.hub-row-actions">
                      <IconButton
                        icon="pencil"
                        iconSize={14}
                        label={t(
                          "editor.chrome.rightPanel.aiChat.historyRename",
                        )}
                        tooltip
                        testId="agent.hub-rename"
                        onClick={() => {
                          setDeletingId(null);
                          setDraft(row.title);
                          setRenamingId(row.id);
                        }}
                      />
                      <IconButton
                        icon="trash-2"
                        iconSize={14}
                        label={t(
                          "editor.chrome.rightPanel.aiChat.historyDelete",
                        )}
                        tooltip
                        testId="agent.hub-delete"
                        onClick={() => {
                          setRenamingId(null);
                          setDeletingId(row.id);
                        }}
                      />
                    </div>
                  </div>
                  <div style={ROW_META_STYLE}>
                    {/* The note the conversation is anchored to, when it is
                    (myne-md/myne#771 story 10). This is what makes "on this
                    note" legible in the Hub, distinct from a vault-general
                    conversation.

                    `.myne-pill`, not the hand-rolled border/radius/padding it
                    was re-deriving — and not `.myne-chiplet`, which it was
                    given first: that class is a 40x28 THEME SWATCH with hidden
                    overflow, so a text label in it is a label nobody can read.
                    Right instinct, wrong class. */}
                    {row.note_id !== undefined ? (
                      <button
                        type="button"
                        className="myne-pill"
                        data-interactive={
                          onOpenNote === undefined ? undefined : "true"
                        }
                        data-testid="agent.hub-anchor"
                        data-note-id={row.note_id}
                        disabled={onOpenNote === undefined}
                        onClick={() => onOpenNote?.(row.note_id!)}
                      >
                        <Icon name="file-text" size={12} />
                        {t("agent.hub.anchorLabel")}
                      </button>
                    ) : null}
                    <span style={META_STYLE}>
                      {relativeDay(row.updated_at, locale, timeZone)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
