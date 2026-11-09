// Conversation history modal for the AI tab (myne-md/myne#675).
//
// Tab-local surface (mounted by `AiChatTab`, not through the Editor's modal
// carve-out): the persisted conversation list with open / rename / delete.
// A single modal layer by construction: the delete confirm renders INLINE in
// the row (body copy + Cancel/Delete), never as a stacked second modal.
//
// Data flow: fetch on mount (always fresh, including sync arrivals),
// re-fetch after every mutation. Opening a conversation binds the transcript
// to it (`openConversation` in `chatPersist.ts`); deleting the OPEN
// conversation discards the transcript via `discardChat()` (a persist of
// deleted turns would fail against the fresh tombstone and stash stale
// state, so the wipe notifies nothing) plus `clearChatPersistForLock()`
// (any earlier stash for the deleted conversation is dropped with it),
// while deleting any OTHER conversation leaves the open transcript untouched.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useDateTimeDisplay } from "../../lib/useDateTimeDisplay";
import { Button } from "../../components/primitives/Button";
import { Input } from "../../components/primitives/Input";
import { EmptyState } from "../../components/primitives/EmptyState";
import { ModalShell } from "../../components/primitives/ModalShell";
import {
  chatsDelete,
  chatsList,
  chatsRename,
  type ConversationListRow,
} from "../../lib/chats";
import { clearChatPersistForLock, openConversation } from "../ai/chatPersist";
import { discardChat, getActiveConversationId } from "../ai/chatStore";
import { byUpdatedDesc, relativeDay } from "../ai/conversationList";

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-2)",
  borderRadius: "var(--radius-1)",
  border: "1px solid var(--line-1)",
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

interface ChatHistoryModalProps {
  open: boolean;
  onClose: () => void;
}

export function ChatHistoryModal({ open, onClose }: ChatHistoryModalProps): ReactNode {
  const { t } = useTranslation();
  const { locale, timeZone } = useDateTimeDisplay();
  const [rows, setRows] = useState<ConversationListRow[] | null>(null);
  const [error, setError] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const activeId = getActiveConversationId();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRows(null);
    setError(false);
    setRenamingId(null);
    setDeletingId(null);
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
  }, [open ]);

  async function refresh(): Promise<void> {
    try {
      // Newest first, client-side: the backend orders the same way, and
      // holding the order here keeps the list correct even if a future
      // backend ever stops guaranteeing it.
      setRows(byUpdatedDesc(await chatsList()));
    } catch {
      setError(true);
    }
  }

  async function handleOpen(id: string): Promise<void> {
    if (id === getActiveConversationId()) {
      onClose();
      return;
    }
    const outcome = await openConversation(id);
    if (outcome === "opened") {
      onClose();
    } else {
      setError(true);
    }
  }

  async function commitRename(id: string): Promise<void> {
    const title = draft.trim();
    if (title.length === 0) {
      setRenamingId(null);
      return;
    }
    try {
      await chatsRename(id, title);
      setRenamingId(null);
      await refresh();
    } catch {
      setError(true);
    }
  }

  async function commitDelete(id: string): Promise<void> {
    try {
      await chatsDelete(id);
      // Only the open transcript dies with its conversation, and it dies
      // WITHOUT a persist: the turns are deleted by intent. Any other open
      // transcript is none of this row's business.
      if (getActiveConversationId() === id) {
        discardChat();
        clearChatPersistForLock();
      }
      setDeletingId(null);
      await refresh();
    } catch {
      setError(true);
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={t("editor.chrome.rightPanel.aiChat.historyTitle")}
      labelId="ai-history-title"
    >
      {/* **The three states are the app's one zero state, and the COPY is the
          agent hub's** (myne-md/myne#867). They used to be three hand-written
          `<p>`s, which is how the same three facts came to be worded twice:
          this modal said "No conversations yet. New chats appear here." while
          the hub's rail, listing conversations over the same store, said "No
          conversations yet" / "Conversations you start appear here.". Two
          surfaces, one fact, one set of words: the hub already had the better
          copy, so it owns it here. The `aiChat.history*` trio stays in the
          catalog because the PHONE's history sheet still renders it, and moving
          that client onto the same copy is task 13's; retiring the keys now
          would break the phone's next build.

          The variants are not styling: `firstRun` is "you have none", `loading`
          is "not yet", `error` is "we could not read them" and offers the
          retry. The testids are unchanged, so every scenario that reaches them
          still does. */}
      {error ? (
        <EmptyState
          variant="error"
          icon="circle-alert"
          size="sm"
          title={t("agent.hub.loadFailed")}
          action={
            <Button
              type="button"
              variant="secondary"
              data-testid="ai.history-retry"
              onClick={() => void refresh()}
            >
              {t("editor.chrome.rightPanel.aiChat.historyRetry")}
            </Button>
          }
          testId="ai.history-error"
        />
      ) : null}
      {rows === null && !error ? (
        <EmptyState
          variant="loading"
          icon="loader-circle"
          size="sm"
          title={t("agent.hub.loading")}
          testId="ai.history-loading"
        />
      ) : null}
      {rows !== null && rows.length === 0 ? (
        <EmptyState
          variant="firstRun"
          icon="message-square"
          size="sm"
          title={t("agent.hub.emptyTitle")}
          body={t("agent.hub.emptyBody")}
          testId="ai.history-empty"
        />
      ) : null}
      {rows !== null && rows.length > 0 ? (
        <div
          data-testid="ai.conversation-list"
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}
        >
          {rows.map((row) => (
            <div key={row.id} data-testid="ai.conversation-row" data-conversation-id={row.id}>
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
                      data-testid="ai.conversation-delete-cancel"
                      onClick={() => setDeletingId(null)}
                    >
                      {t("editor.chrome.rightPanel.aiChat.historyCancel")}
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      data-testid="ai.conversation-delete-confirm"
                      onClick={() => void commitDelete(row.id)}
                    >
                      {t("editor.chrome.rightPanel.aiChat.historyDelete")}
                    </Button>
                  </div>
                </div>
              ) : renamingId === row.id ? (
                <div style={ROW_STYLE}>
                  <Input
                    data-testid="ai.conversation-rename-input"
                    aria-label={t("common.rename")}
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
                    data-testid="ai.conversation-rename-confirm"
                    onClick={() => void commitRename(row.id)}
                  >
                    {t("common.rename")}
                  </Button>
                </div>
              ) : (
                <div style={ROW_STYLE} data-active={row.id === activeId ? "true" : "false"}>
                  <button
                    type="button"
                    data-testid="ai.conversation-open"
                    onClick={() => void handleOpen(row.id)}
                    style={TITLE_STYLE}
                    title={row.title}
                  >
                    {row.title}
                  </button>
                  <span style={META_STYLE}>
                    {relativeDay(
                      row.updated_at > 0 ? row.updated_at : row.created_at,
                      locale,
                      timeZone,
                    )}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    data-testid="ai.conversation-rename"
                    aria-label={t("common.rename")}
                    onClick={() => {
                      setDeletingId(null);
                      setDraft(row.title);
                      setRenamingId(row.id);
                    }}
                  >
                    {t("common.rename")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    data-testid="ai.conversation-delete"
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
      ) : null}
    </ModalShell>
  );
}
