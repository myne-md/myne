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

import { useEffect, useRef, useState } from "react";
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
  padding: "var(--space-2) var(--space-3)",
  // 44px touch floor on the client where every tap is a finger: the token
  // padding alone sizes below it on one-line labels.
  minHeight: 44,
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
  /**
   * The hub's filter (myne-md/myne#771 task 14).
   *
   * Client-side over the roster already in memory, exactly as the desktop hub
   * does it: the catalog is small and a server-side search would be a second
   * answer to a question one answer already covers.
   */
  const [query, setQuery] = useState("");
  /**
   * Which conversations this sheet is showing: the ones anchored to the open
   * note, or every conversation in the vault.
   *
   * This is the mode control the task asks for, and it is about the ANCHOR
   * rather than about a run's scope — which is the only reading the host
   * permits. `defaultGrantFor` records why: a folder grant with an empty path
   * IS the vault root, `is_root_grant` refuses one before resolving, and a
   * client that offered "run on the whole vault" would be offering a Send that
   * cannot work. So "on vault" here means a conversation that is about no
   * particular note, which is exactly what an absent `note_id` is.
   */
  const [mode, setMode] = useState<"note" | "vault">("vault");

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

  // Dialog focus: move into the card on open, return to the opener on close.
  // (No full focus trap: the sheet holds no tabbable loop worth trapping;
  // Escape and scrim-tap are the exits.)
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => {
      opener?.focus?.();
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

  // What the list is actually showing: the mode narrows it to conversations
  // anchored to a note, the query narrows it by title, and the two compose.
  // Computed here rather than inside the render so the "filtered to nothing"
  // branch and the list read the same array — two `.filter()` calls would be
  // two chances for them to disagree about whether there is anything to show.
  const q = query.trim().toLowerCase();
  const visible = (rows ?? []).filter((r) => {
    if (mode === "note" && (r.note_id === undefined || r.note_id === "")) return false;
    return q === "" || r.title.toLowerCase().includes(q);
  });

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
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div ref={cardRef} tabIndex={-1} style={CARD}>
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
          {rows !== null && rows.length > 0 ? (
            <>
              {/* The mode control. Two words, not an icon: on a phone this is
                  the one thing that decides what the list means, and a glyph
                  for "anchored to this note" is a glyph nobody can read. */}
              <div
                role="group"
                aria-label={t("agent.hub.modeLabel")}
                data-testid="ai.history-mode"
                style={{ display: "flex", gap: "var(--space-1)", marginBottom: "var(--space-3)" }}
              >
                {(["vault", "note"] as const).map((m) => (
                  <Button
                    key={m}
                    variant={mode === m ? "primary" : "secondary"}
                    full={false}
                    data-testid={`ai.history-mode-${m}`}
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                  >
                    {m === "vault" ? t("agent.hub.modeVault") : t("agent.hub.modeNote")}
                  </Button>
                ))}
              </div>
              {/* A raw `<input>`: this tree has a `Button` primitive and no
                  input one, so there is nothing to adopt. Recorded in
                  `scripts/primitive-adoption.json` rather than converted, which
                  is what that guard asks for when an element genuinely is not a
                  primitive — the rename field two branches down is the same
                  case and has been for as long as this sheet has existed. */}
              <input
                type="search"
                data-testid="ai.history-search"
                aria-label={t("agent.hub.searchLabel")}
                placeholder={t("agent.hub.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ width: "100%", marginBottom: "var(--space-3)" }}
              />
            </>
          ) : null}
          {rows !== null && rows.length === 0 ? (
            <p data-testid="ai.history-empty" style={META}>
              {t("editor.chrome.rightPanel.aiChat.historyEmpty")}
            </p>
          ) : null}
          {rows !== null && rows.length > 0 && visible.length === 0 ? (
            // Filtered to nothing is NOT an empty vault, and the distinction is
            // the same one the desktop hub draws: this state echoes what was
            // typed and offers the way back, where the empty one above explains
            // what would put something here.
            <p data-testid="ai.history-no-match" style={META}>
              {t("agent.hub.noMatchTitle")}
            </p>
          ) : null}
          {rows !== null && visible.length > 0 ? (
            <div data-testid="ai.conversation-list">
              {visible.map((row) => (
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
                      <span data-testid="ai.conversation-delete-title" style={ROW_TITLE}>
                        {t("editor.chrome.rightPanel.aiChat.historyDeleteTitle")}
                      </span>
                      <span data-testid="ai.conversation-delete-body" style={META}>
                        {t("editor.chrome.rightPanel.aiChat.historyDeleteBody")}
                      </span>
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
                      {row.note_id !== undefined && row.note_id !== "" ? (
                        // The anchor, as the shared chiplet the desktop hub
                        // uses. What makes "about this note" legible in a list
                        // where every other row is about the vault.
                        <span
                          className="myne-chiplet"
                          data-testid="ai.conversation-anchor"
                          data-note-id={row.note_id}
                        >
                          {t("agent.hub.anchorLabel")}
                        </span>
                      ) : null}
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
