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
import { Icon } from "../../components/Icon";
import { EmptyState } from "@myne/client-core/emptyState";
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

/** The target glyph, so a row states what the conversation is about. */
const TARGET: CSSProperties = {
  flex: "none",
  display: "inline-flex",
  color: "var(--fg-3)",
};

/** The three-dot trigger: only what the primitive does not already do, which is
 *  the 44px touch floor every tap target here keeps and the width it gives back
 *  to the title. */
const MENU_TRIGGER: CSSProperties = {
  flex: "none",
  width: 44,
  height: 44,
  padding: 0,
};

/** The menu: a bordered panel under the trigger, not a second sheet. */
const MENU: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  background: "var(--bg-2)",
  overflow: "hidden",
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
  /** Which row's three-dot menu is open (myne-md/myne#848). */
  const [menuId, setMenuId] = useState<string | null>(null);
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
          {/* **`EmptyState`, carrying the hub's copy** (myne-md/myne#867). Three
              states used to render three hand-written sentences here while the
              hub's rail rendered the same three facts in its own words: the two
              surfaces list the same conversations over the same store, so a
              reader who saw both read two vocabularies for one thing. The hub
              owns the copy and this sheet renders it, and the component is the
              app's zero state rather than a second one with the same words.

              `EmptyState` moved to `@myne/client-core` in this same change (it
              was desktop-only while its stylesheet was already shared), which is
              what lets the phone render it. `aiChat.historyError` stays in the
              catalog for the two transcript banners that still render it
              (`ConversationSurface`, mobile `AiChatFlow`); the empty and loading
              keys are the hub's now.

              The glyph is a NODE because each client owns its icon registry: the
              names below are this client's (`alert-triangle`,
              `message-square`), not the desktop's. Loading has no glyph at all,
              which is what "defer to the skeleton convention" looks like when
              the phone has no skeleton for a sheet. */}
          {error ? (
            <EmptyState
              variant="error"
              size="sm"
              glyph={<Icon name="alert-triangle" size={20} />}
              title={t("agent.hub.loadFailed")}
              testId="ai.history-error"
            />
          ) : null}
          {rows === null && !error ? (
            <EmptyState
              variant="loading"
              size="sm"
              title={t("agent.hub.loading")}
              testId="ai.history-loading"
            />
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
            <EmptyState
              variant="firstRun"
              size="sm"
              glyph={<Icon name="message-square" size={20} />}
              title={t("agent.hub.emptyTitle")}
              body={t("agent.hub.emptyBody")}
              testId="ai.history-empty"
            />
          ) : null}
          {rows !== null && rows.length > 0 && visible.length === 0 ? (
            // **Filtered to nothing is NOT an empty vault** (the distinction the
            // desktop hub draws). It echoes what was typed (`noMatchBody` takes
            // the query) and offers the way back, which this sheet was NOT
            // doing: it rendered the title and dropped the body, so the one
            // sentence naming the fix never reached the phone.
            <EmptyState
              variant="filtered"
              size="sm"
              glyph={<Icon name="message-square" size={20} />}
              title={t("agent.hub.noMatchTitle")}
              // The query is echoed by the SENTENCE rather than by the
              // component's own `query` prop, because `noMatchBody` already
              // interpolates it: passing both would print it twice.
              body={t("agent.hub.noMatchBody", { query })}
              action={
                <Button
                  variant="secondary"
                  full={false}
                  data-testid="ai.history-clear-search"
                  onClick={() => setQuery("")}
                >
                  {t("agent.hub.searchClear")}
                </Button>
              }
              testId="ai.history-no-match"
            />
          ) : null}
          {rows !== null && visible.length > 0 ? (
            <div data-testid="ai.conversation-list">
              {visible.map((row) => (
                <div
                  key={row.id}
                  data-testid="ai.conversation-row"
                  data-conversation-id={row.id}
                  data-active={row.id === activeId ? "true" : undefined}
                  /* **The whole row is the target** (myne-md/myne#848), as a
                     touch convenience rather than as the control: the CONTROL is
                     the title button inside it, and the row also holds the
                     three-dot trigger and its menu, so making the row itself a
                     `role="button"` would be a control inside a control and
                     would swallow those buttons' labels into the row's name.
                     This is `ViewsSheet`'s shape (and the note row's), and the
                     file is exempt in
                     `tests/a11y-tappable.test.tsx::NOT_CONTROLS` with that
                     reason. Rename and delete moved behind the three-dot
                     trigger: four controls on every line is most of a 390px
                     screen, and the list stopped reading as titles. */
                  onClick={() => {
                    // **A click inside the rename or delete branch is not a row
                    // choice** (myne-md/myne#848): it bubbles here, and opening
                    // the conversation would close the sheet mid-rename. The
                    // buttons in those branches stop propagation on their own;
                    // this is the row's own guard, so the branch's text does not
                    // need four more.
                    if (renamingId === row.id || deletingId === row.id) return;
                    onOpen(row.id);
                  }}
                  style={{
                    ...ROW,
                    // The menu is a child of this row, so the row has to be able
                    // to wrap for it to land BELOW the title line rather than
                    // beside it.
                    flexWrap: "wrap",
                    cursor: "pointer",
                    background: row.id === activeId ? "var(--bg-2)" : "transparent",
                  }}
                >
                  {renamingId === row.id ? (
                    <>
                      <input
                        data-testid="ai.conversation-rename-input"
                        aria-label={t("common.rename")}
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
                        aria-label={t("common.rename")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void commitRename(row.id);
                        }}
                        style={SMALL_BUTTON}
                      >
                        {t("common.rename")}
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
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeletingId(null);
                        }}
                        style={SMALL_BUTTON}
                      >
                        {t("editor.chrome.rightPanel.aiChat.historyCancel")}
                      </button>
                    </>
                  ) : (
                    <>
                      {/* What the conversation is about, as a glyph with an
                          accessible name: the same three kinds the desktop hub
                          draws. A conversation carries at most one anchor. */}
                      <span
                        // **`role="img"`** (myne-md/myne#848): an `aria-label` on a
                        // bare span is prohibited and axe drops the name with it,
                        // which is the same fix the desktop twin carries.
                        role="img"
                        aria-label={
                          row.folder !== undefined && row.folder !== ""
                            ? t("agent.hub.targetFolder")
                            : row.note_id !== undefined && row.note_id !== ""
                              ? t("agent.hub.targetNote")
                              : t("agent.hub.targetVault")
                        }
                        data-testid="ai.conversation-target"
                        data-target={
                          row.folder !== undefined && row.folder !== ""
                            ? "folder"
                            : row.note_id !== undefined && row.note_id !== ""
                              ? "note"
                              : "vault"
                        }
                        style={TARGET}
                      >
                        <Icon
                          name={
                            row.folder !== undefined && row.folder !== ""
                              ? "folder"
                              : row.note_id !== undefined && row.note_id !== ""
                                ? "file-text"
                                : "message-square"
                          }
                          size={16}
                        />
                      </span>
                      <button
                        type="button"
                        data-testid="ai.conversation-open"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(row.id);
                        }}
                        style={{ ...ROW_TITLE, textAlign: "left", cursor: "pointer" }}
                      >
                        {row.title}
                      </button>
                      {row.note_id !== undefined && row.note_id !== "" ? (
                        // **The anchored row's chip, kept beside the glyph**
                        // (myne-md/myne#848). The glyph says the KIND for every
                        // row; the chip carries the note id the caller uses to
                        // open it, and it is what the user reads as "about this
                        // note" rather than as "about something".
                        <span
                          // **`myne-pill`, not `myne-chiplet`** (myne-md/myne#867).
                          // `chiplet` is a fixed 40x28 COLOUR SWATCH with
                          // `overflow: hidden` (it is the theme swatch), so a
                          // text label inside it was cut off: the row read "On a"
                          // where it meant "On a note". The desktop hub was moved
                          // to the pill when this was first found, and the phone
                          // kept the swatch; `docs/design/README.md`'s "a text chip
                          // is not a theme swatch" is the rule, and
                          // `tests/styles/componentLayer.test.ts` holds the two
                          // classes apart.
                          className="myne-pill"
                          data-testid="ai.conversation-anchor"
                          data-note-id={row.note_id}
                        >
                          {t("agent.hub.anchorLabel")}
                        </span>
                      ) : null}
                      <span style={ROW_META}>
                        {formatRelativeTime(new Date(row.updated_at))}
                      </span>
                      <Button
                        variant="ghost"
                        full={false}
                        data-testid="ai.conversation-menu"
                        aria-label={t("agent.hub.menu")}
                        aria-expanded={menuId === row.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenamingId(null);
                          setDeletingId(null);
                          setMenuId(menuId === row.id ? null : row.id);
                        }}
                        style={MENU_TRIGGER}
                      >
                        <Icon name="more-horizontal" size={18} />
                      </Button>
                    </>
                  )}
                  {menuId === row.id ? (
                    <div
                      data-testid="ai.conversation-menu-list"
                      style={{ ...MENU, flexBasis: "100%", marginTop: "var(--space-1)" }}
                      // **A tap inside the menu is not a tap on the row.** The
                      // row opens the conversation on click, so every control
                      // that sits inside it has to stop the event or choosing
                      // Rename would also open the conversation behind the menu.
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        data-testid="ai.conversation-rename"
                        onClick={() => {
                          setDeletingId(null);
                          setMenuId(null);
                          setDraft(row.title);
                          setRenamingId(row.id);
                        }}
                        style={{ ...SMALL_BUTTON, textAlign: "left" }}
                      >
                        {t("common.rename")}
                      </button>
                      <button
                        type="button"
                        data-testid="ai.conversation-delete"
                        onClick={() => {
                          setRenamingId(null);
                          setMenuId(null);
                          setDeletingId(row.id);
                        }}
                        style={{ ...DELETE_CONFIRM_BUTTON, textAlign: "left" }}
                      >
                        {t("editor.chrome.rightPanel.aiChat.historyDelete")}
                      </button>
                    </div>
                  ) : null}
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
