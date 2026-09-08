// The phone's conversation-history sheet (myne-md/myne#675, task 13).
//
// Bottom-sheet anatomy mirroring `AiScopeSheet` (fixed scrim + bottom card,
// same radii and tokens): list the roster newest-first, open one, start a new
// chat, rename inline, delete with an inline two-tap confirm (the
// `archive.folder-delete-confirm` pattern: a separate confirm sheet for a row
// action would be a second modal layer over the sheet).
//
// This sheet OWNS no transcript state: rows come in as props, and every
// mutation reports back out (`onOpen`/`onNew`/`onRenamed`/`onDeleted`) so the
// caller stays the single owner of the active conversation. What it owns is
// the list's own loading/error/rename/delete-arm UI state.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../components/Button";
import { chatsDelete, chatsList, chatsRename, type ConversationListRow } from "../../lib/chats";
import { formatRelativeTime } from "../../lib/relative-time";

const SCRIM: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 40,
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-end",
  background: "var(--scrim, rgba(0,0,0,0.45))",
};

const CARD: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  maxHeight: "88%",
  background: "var(--bg-1)",
  borderTopLeftRadius: "var(--radius-3)",
  borderTopRightRadius: "var(--radius-3)",
  borderTop: "1px solid var(--line-1)",
};

const BODY: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "var(--space-4)",
};

const TITLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
};

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-2) 0",
  borderBottom: "1px solid var(--line-1)",
};

const ROW_TITLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "var(--text-base)",
  color: "var(--fg-1)",
};

const ROW_META: CSSProperties = {
  flex: "none",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

const META: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const ERROR_TEXT: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

const ACTIONS: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  padding: "var(--space-3) var(--space-4) calc(var(--space-3) + env(safe-area-inset-bottom, 0px))",
  borderTop: "1px solid var(--line-1)",
};

const SMALL_BUTTON: CSSProperties = {
  border: "none",
  background: "transparent",
  color: "var(--fg-2)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-semibold)",
  cursor: "pointer",
  padding: "6px 8px",
};

const DELETE_CONFIRM_BUTTON: CSSProperties = {
  ...SMALL_BUTTON,
  color: "var(--danger)",
};

export function AiHistorySheet({
  activeId,
  onOpen,
  onNew,
  onDeleted,
  onClose,
}: {
  /** The open conversation, if any: its row renders active and deleting it
   *  clears the caller's transcript (the desktop delete-own discipline). */
  activeId: string | null;
  /** A row was chosen: the caller reads it, binds it, and closes this sheet. */
  onOpen: (id: string) => void;
  /** New chat: the caller clears its transcript; the next send creates. */
  onNew: () => void;
  /** A row was deleted (after confirm): the caller drops it if it was open. */
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ConversationListRow[] | null>(null);
  const [error, setError] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      // Newest first, client-side: the backend orders the same way, and
      // holding the order here keeps the list correct even if a future
      // backend ever stops guaranteeing it (the desktop modal's discipline).
      const list = [...(await chatsList())].sort((a, b) => b.updated_at - a.updated_at);
      setRows(list);
    } catch {
      setError(true);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void chatsList()
      .then((list) => {
        if (!cancelled) {
          setRows([...list].sort((a, b) => b.updated_at - a.updated_at));
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      setDeletingId(null);
      await refresh();
      onDeleted(id);
    } catch {
      setError(true);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-history-title"
      data-testid="ai.history-sheet"
      style={SCRIM}
      onClick={(e) => {
        // Scrim tap dismisses; taps inside the card must not bubble up to it.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={CARD}>
        <div style={BODY}>
          <h2 id="ai-history-title" data-testid="ai.history-title" style={TITLE}>
            {t("editor.chrome.rightPanel.aiChat.historyTitle")}
          </h2>
          {error ? (
            <p data-testid="ai.history-error" style={ERROR_TEXT}>
              {t("editor.chrome.rightPanel.aiChat.historyError")}
            </p>
          ) : null}
          {rows === null && !error ? (
            <p data-testid="ai.history-loading" style={META}>
              {t("editor.chrome.rightPanel.aiChat.historyLoading")}
            </p>
          ) : null}
          {rows !== null && rows.length === 0 ? (
            <p data-testid="ai.history-empty" style={META}>
              {t("editor.chrome.rightPanel.aiChat.historyEmpty")}
            </p>
          ) : null}
          {rows !== null && rows.length > 0 ? (
            <div data-testid="ai.conversation-list">
              {rows.map((row) => (
                <div
                  key={row.id}
                  data-testid="ai.conversation-row"
                  data-conversation-id={row.id}
                  data-active={row.id === activeId ? "true" : undefined}
                  style={ROW}
                >
                  {renamingId === row.id ? (
                    <>
                      <input
                        data-testid="ai.conversation-rename-input"
                        aria-label={t("editor.chrome.rightPanel.aiChat.historyRename")}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename(row.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        autoFocus
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      <button
                        type="button"
                        data-testid="ai.conversation-rename-confirm"
                        aria-label={t("editor.chrome.rightPanel.aiChat.historyRename")}
                        onClick={() => void commitRename(row.id)}
                        style={SMALL_BUTTON}
                      >
                        {t("editor.chrome.rightPanel.aiChat.historyRename")}
                      </button>
                    </>
                  ) : deletingId === row.id ? (
                    <>
                      <span style={ROW_TITLE}>{row.title}</span>
                      <button
                        type="button"
                        data-testid="ai.conversation-delete-confirm"
                        onClick={(e) => {
                          e.stopPropagation();
                          void commitDelete(row.id);
                        }}
                        style={DELETE_CONFIRM_BUTTON}
                      >
                        {t("editor.chrome.rightPanel.aiChat.historyDelete")}
                      </button>
                      <button
                        type="button"
                        data-testid="ai.conversation-delete-cancel"
                        onClick={() => setDeletingId(null)}
                        style={SMALL_BUTTON}
                      >
                        {t("editor.chrome.rightPanel.aiChat.historyCancel")}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        data-testid="ai.conversation-open"
                        onClick={() => onOpen(row.id)}
                        style={{ ...ROW_TITLE, textAlign: "left", cursor: "pointer" }}
                      >
                        {row.title}
                      </button>
                      <span style={ROW_META}>
                        {formatRelativeTime(new Date(row.updated_at))}
                      </span>
                      <button
                        type="button"
                        data-testid="ai.conversation-rename"
                        aria-label={t("editor.chrome.rightPanel.aiChat.historyRename")}
                        onClick={() => {
                          setDeletingId(null);
                          setDraft(row.title);
                          setRenamingId(row.id);
                        }}
                        style={SMALL_BUTTON}
                      >
                        {t("editor.chrome.rightPanel.aiChat.historyRename")}
                      </button>
                      <button
                        type="button"
                        data-testid="ai.conversation-delete"
                        aria-label={t("editor.chrome.rightPanel.aiChat.historyDelete")}
                        onClick={() => {
                          setRenamingId(null);
                          setDeletingId(row.id);
                        }}
                        style={SMALL_BUTTON}
                      >
                        {t("editor.chrome.rightPanel.aiChat.historyDelete")}
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div style={ACTIONS}>
          <Button
            variant="secondary"
            data-testid="ai.history-new-chat"
            onClick={() => {
              onNew();
              onClose();
            }}
          >
            {t("editor.chrome.rightPanel.aiChat.newChat")}
          </Button>
          <Button variant="ghost" data-testid="ai.history-close" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </div>
    </div>
  );
}
