// The home surface's widget bodies (myne-md/myne#1074).
//
// ── The one rule ────────────────────────────────────────────────────────────
// **A widget never owns its data.** Every body here reads the module that already
// answers its question — `recentNoteIds`, `prefs.favorites`, `useLiveVaultTasks`,
// `useLiveCalendarEvents`, the attachment catalog, the chats roster, the shared
// sync-status mapping — and renders a bounded summary plus one way deeper. A
// widget with its own query is a second answer to a question the app already
// answers, and the two drift the first time only one of them is touched.
//
// ── Density is the design ───────────────────────────────────────────────────
// A widget on a home surface is scanned, not read. So: no sentence that explains
// what the widget is (the picker says that once, where it is needed), no footer
// button repeating what the header already offers, and no empty state longer than
// the fact it reports. "Nothing is starred yet" is a fact; "Star a note and it
// lands here" is onboarding, and onboarding text on a permanent surface is
// furniture that never leaves.
//
// ── Empty is a state, not a bug ─────────────────────────────────────────────
// A widget on an empty vault says what it WOULD show in one line. That is
// different from saying nothing, which reads as the widget being broken.

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { AttachmentThumbnail } from "../../components/attachments/AttachmentThumbnail";
import {
  attachmentUnusedList,
  catalogList,
  type CatalogEntry,
} from "../../lib/attachments";
import { chatsList, type ConversationListRow } from "../../lib/chats";
import { seedComposer } from "../ai/composerSeed";
import { syncStatusView } from "../../lib/sync-status-view";
import { usePrefs } from "../../hooks/usePrefs";
import { useSyncStatus } from "../../hooks/useSyncStatus";
import { useLiveCalendarEvents } from "../../hooks/useLiveCalendarEvents";
import { useSelectedNoteOptional } from "../sidebarState";
import { useLiveVaultTasks } from "../taskIndex";
import { useWorkspace } from "../workspaceContext";
import { createNote } from "../createNote";
import { recentNoteIds } from "../recentNotes";
import type { HomeCard } from "../../lib/prefs";

import { useHomeLayout } from "./HomeLayoutContext";

/** How many rows a widget shows before it stops being a summary. */
const MAX_ROWS = 5;

/** What one widget contributes to the surface. */
export interface HomeCardDef {
  /** The body: everything under the widget's header. */
  Body: (props: { card: HomeCard }) => ReactElement;
  /**
   * The header's trailing control, when the widget has somewhere deeper to go.
   *
   * Rendered in the HEADER rather than as a footer button: four cards in the old
   * layout each ended in an "Open the …" button, which turned every widget into a
   * box with a link under it. Same fact, one line higher, no box.
   */
  HeaderAction?: (props: { card: HomeCard }) => ReactElement | null;
}

/** A row: the label, and optionally what it is, in the app's voice. */
function Row({
  label,
  note,
  onClick,
  testId,
  icon,
}: {
  label: string;
  note?: string;
  onClick?: () => void;
  testId?: string;
  icon?: ReactElement;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={onClick === undefined}
      data-testid={testId}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-2)",
        width: "100%",
        // A row is a hit target, not a paragraph: the vertical padding is the
        // touch floor's share, and the row list owns the gap between rows.
        padding: "var(--space-1) 0",
        border: "none",
        background: "none",
        textAlign: "start",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        color: "var(--fg-1)",
        cursor: onClick === undefined ? "default" : "pointer",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
        {icon}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      </span>
      {note !== undefined && (
        <span style={{ flexShrink: 0, color: "var(--fg-3)", fontSize: "var(--text-xs)" }}>{note}</span>
      )}
    </button>
  );
}

/** One factual line: what the widget would show, or how little there is. */
function Empty({ text }: { text: string }) {
  return (
    <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)", lineHeight: 1.5 }}>{text}</div>
  );
}

/** A number and its noun: the shape most of the state widgets reduce to. */
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)" }}>
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-lg)",
          fontWeight: "var(--weight-semibold)" as unknown as number,
          color: "var(--fg-1)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
      <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>{label}</span>
    </div>
  );
}

/** Byte size, in the units a person thinks in. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Titles from the sidebar's resolver cache, the same source a tab label uses. */
function useTitles(): ReadonlyMap<string, string> {
  const ctx = useSelectedNoteOptional();
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (ctx === null) return;
    const next = new Map<string, string>();
    for (const [id, record] of ctx.cache) {
      if (record.title !== null && record.title !== undefined) next.set(id, record.title);
    }
    setTitles(next);
  }, [ctx]);
  return titles;
}

/**
 * The attachment catalog, read once per mount: the same command the library uses.
 *
 * Returns `null` while loading, which every caller renders as a loading line
 * rather than as an empty state: "not read yet" and "nothing there" are different
 * facts and only one of them is worth acting on.
 */
function useCatalog(): readonly CatalogEntry[] | null {
  const [rows, setRows] = useState<readonly CatalogEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void catalogList()
      .then((entries) => {
        if (!cancelled) setRows(entries);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return rows;
}

// ── Capture ─────────────────────────────────────────────────────────────────

/**
 * The chat bar: type a line, press Enter, land in the conversation.
 *
 * **A bar, not a card** — one line, a leading glyph, a trailing action, Enter to
 * submit, and the recent conversations as a flat list underneath. That is the
 * shape every command surface converges on, and the difference from a chat bubble
 * is height and placement, not decoration.
 *
 * It seeds the composer instead of sending: the composer owns the consent gates
 * (which provider, which scope, what leaves the device), and a home widget that
 * sent on its own would be a second path around them.
 */
function StartChatBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const ws = useWorkspace();
  const [text, setText] = useState("");
  const [recent, setRecent] = useState<readonly ConversationListRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void chatsList()
      .then((rows) => {
        if (!cancelled) setRecent([...rows].sort((a, b) => b.updated_at - a.updated_at).slice(0, 4));
      })
      .catch(() => {
        if (!cancelled) setRecent([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback(() => {
    const prompt = text.trim();
    if (prompt === "") {
      ws.openAgent();
      return;
    }
    ws.openAgent();
    // The composer picks this up on mount and clears it, so a later visit to the
    // agent surface does not resurrect a prompt the user already spent.
    seedComposer(prompt);
    setText("");
  }, [text, ws]);

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          start();
        }}
        style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
      >
        <span style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0, gap: "var(--space-2)" }}>
          <span style={{ display: "flex", color: "var(--fg-3)" }}>
            <Icon name="bot" size={16} />
          </span>
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("notes.home.cards.startChatPlaceholder")}
            aria-label={t("notes.home.cards.startChatPlaceholder")}
            data-testid="home.card.start-chat.input"
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--fg-1)",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-md)",
            }}
          />
        </span>
        <Button
          type="submit"
          variant="secondary"
          data-testid="home.card.start-chat.go"
          disabled={text.trim() === "" && recent !== null && recent.length === 0}
        >
          {t("notes.home.cards.startChatGo")}
        </Button>
      </form>
      {recent === null ? null : recent.length === 0 ? null : (
        <div style={{ marginTop: "var(--space-1)" }}>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)", marginBottom: "var(--space-1)" }}>
            {t("notes.home.cards.recentChats")}
          </div>
          {recent.map((row) => (
            <Row
              key={row.id}
              label={row.title}
              note={relativeDay(row.updated_at, t)}
              onClick={() => ws.openAgent()}
              testId={`home.card.start-chat.row.${row.id}`}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** "today" / "yesterday" / a date, from a Unix-seconds stamp. */
function relativeDay(seconds: number, t: (key: string) => string): string {
  const then = new Date(seconds * 1000);
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const diff = Math.round((startOfToday - startOfThen) / day);
  if (diff === 0) return t("notes.home.cards.today");
  if (diff === 1) return t("notes.home.cards.yesterday");
  return then.toLocaleDateString();
}

/**
 * Quick capture: one line becomes a note.
 *
 * It creates through `createNote` with the typed line as the STARTING TITLE, which
 * is the same helper "+ New note" calls, so the note this makes is
 * indistinguishable from one made anywhere else.
 */
function QuickCaptureBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const ws = useWorkspace();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const capture = useCallback(() => {
    const title = text.trim();
    if (title === "" || busy) return;
    setBusy(true);
    void createNote(null, title)
      .then((id) => {
        setText("");
        ws.openInFocused(id);
      })
      .finally(() => setBusy(false));
  }, [busy, text, ws]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        capture();
      }}
      style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}
    >
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t("notes.home.cards.quickCapturePlaceholder")}
        aria-label={t("notes.home.cards.quickCapturePlaceholder")}
        data-testid="home.card.quick-capture.input"
        style={{
          flex: 1,
          minWidth: 0,
          border: "none",
          outline: "none",
          background: "transparent",
          color: "var(--fg-1)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-md)",
        }}
      />
      <Button type="submit" variant="secondary" disabled={busy || text.trim() === ""}>
        {t("notes.home.cards.quickCaptureGo")}
      </Button>
    </form>
  );
}

/**
 * The markdown block: a line, a quote, a reminder.
 *
 * **Plain text with a quote treatment, not a note editor.** The content lives in
 * the card's own `options.markdown` (encrypted, synced, bounded at 1 KiB), which
 * is what makes a home block editable without a second write path into the vault:
 * nothing here can corrupt a note, and nothing here appears in the note tree.
 */
function MarkdownBody({ card }: { card: HomeCard }) {
  const { t } = useTranslation();
  const { setOptions } = useHomeLayout();
  const stored = card.options?.markdown ?? "";
  const [draft, setDraft] = useState(stored);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setDraft(stored);
  }, [stored]);

  const commit = useCallback(() => {
    setEditing(false);
    if (draft === stored) return;
    setOptions(card.id, { markdown: draft });
  }, [card.id, draft, setOptions, stored]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        data-testid="home.card.markdown.view"
        style={{
          display: "block",
          width: "100%",
          textAlign: "start",
          border: "none",
          background: "none",
          padding: 0,
          cursor: "text",
          borderInlineStart: stored === "" ? "none" : "2px solid var(--line-2)",
          paddingInlineStart: stored === "" ? 0 : "var(--space-3)",
          fontFamily: "var(--font-serif, var(--font-sans))",
          fontSize: "var(--text-lg)",
          lineHeight: 1.5,
          color: stored === "" ? "var(--fg-3)" : "var(--fg-1)",
          whiteSpace: "pre-wrap",
        }}
      >
        {stored === "" ? (
          <span style={{ color: "var(--fg-3)" }}>{t("notes.home.cards.markdownPlaceholder")}</span>
        ) : (
          stored
        )}
      </button>
    );
  }

  return (
    <textarea
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      autoFocus
      placeholder={t("notes.home.cards.markdownPlaceholder")}
      aria-label={t("notes.home.cards.markdown")}
      data-testid="home.card.markdown.input"
      style={{
        width: "100%",
        minHeight: 72,
        resize: "vertical",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-1)",
        background: "var(--bg-1)",
        color: "var(--fg-1)",
        fontFamily: "var(--font-serif, var(--font-sans))",
        fontSize: "var(--text-md)",
        lineHeight: 1.6,
        padding: "var(--space-2)",
      }}
    />
  );
}

function TemplatesBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const ws = useWorkspace();
  return (
    <Row
      label={t("notes.home.cards.templatesAction")}
      onClick={() => ws.openTemplates()}
      testId="home.card.templates.open"
    />
  );
}

// ── Navigate ────────────────────────────────────────────────────────────────

function RecentNotesBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const ws = useWorkspace();
  const titles = useTitles();
  const ids = recentNoteIds().slice(0, MAX_ROWS);
  if (ids.length === 0) return <Empty text={t("notes.home.cards.recentNotesEmpty")} />;
  return (
    <>
      {ids.map((id) => (
        <Row
          key={id}
          label={titles.get(id) ?? t("common.untitled")}
          onClick={() => ws.openInFocused(id)}
          testId={`home.card.row.${id}`}
        />
      ))}
    </>
  );
}

function FavoritesBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const ws = useWorkspace();
  const titles = useTitles();
  const { prefs } = usePrefs();
  const ids = prefs.favorites.slice(0, MAX_ROWS);
  if (ids.length === 0) return <Empty text={t("notes.home.cards.favoritesEmpty")} />;
  return (
    <>
      {ids.map((id) => (
        <Row
          key={id}
          label={titles.get(id) ?? t("common.untitled")}
          onClick={() => ws.openInFocused(id)}
          testId={`home.card.row.${id}`}
        />
      ))}
    </>
  );
}

function SavedViewsBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const ws = useWorkspace();
  const { prefs } = usePrefs();
  const views = prefs.saved_views.slice(0, MAX_ROWS);
  if (views.length === 0) return <Empty text={t("notes.home.cards.savedViewsEmpty")} />;
  return (
    <>
      {views.map((view) => (
        <Row key={view.id} label={view.name} onClick={() => ws.openView(view.id)} />
      ))}
    </>
  );
}

function FoldersBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const ws = useWorkspace();
  const rows = useCatalog();
  if (rows === null) return <Empty text={t("notes.home.cards.loading")} />;
  // A folder is one namespace for typed notes and imported files, so the widget
  // counts what each folder holds rather than inventing a second grouping
  // (myne-md/myne#1075).
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.folder === "") continue;
    counts.set(row.folder, (counts.get(row.folder) ?? 0) + 1);
  }
  const folders = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ROWS);
  if (folders.length === 0) return <Empty text={t("notes.home.cards.referenceSetsEmpty")} />;
  return (
    <>
      {folders.map(([folder, count]) => (
        <Row
          key={folder}
          label={folder.replace(/\/$/, "")}
          note={t("notes.home.cards.fileCount", { count })}
          onClick={() => ws.openAttachments()}
        />
      ))}
    </>
  );
}

function GraphBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const titles = useTitles();
  return (
    <>
      <Stat value={String(titles.size)} label={t("notes.home.cards.notesShort")} />
      <Empty text={t("notes.home.cards.graphHint")} />
    </>
  );
}

// ── Time ────────────────────────────────────────────────────────────────────

function TodaysTasksBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const ws = useWorkspace();
  const tasks = useLiveVaultTasks();
  const open = tasks.filter((task) => !task.completed);
  if (open.length === 0) return <Empty text={t("notes.home.cards.todaysTasksEmpty")} />;
  return (
    <>
      {open.slice(0, MAX_ROWS).map((task) => (
        <Row
          key={`${task.noteId}:${task.lineIndex ?? "note"}`}
          label={task.rawLine.replace(/^[-*]\s*\[.\]\s*/, "").slice(0, 80)}
          note={task.due ?? task.noteTitle ?? undefined}
          onClick={() => ws.openInFocused(task.noteId)}
        />
      ))}
    </>
  );
}

function CalendarAgendaBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const ws = useWorkspace();
  const titles = useTitles();
  // An occurrence carries the note it belongs to and when it starts, not a title:
  // the title lives in the cache, the same place a tab label reads it.
  const events = useLiveCalendarEvents(7).slice(0, MAX_ROWS);
  if (events.length === 0) return <Empty text={t("notes.home.cards.calendarAgendaEmpty")} />;
  return (
    <>
      {events.map((event) => (
        <Row
          key={`${event.noteId}:${event.start}`}
          label={titles.get(event.noteId) ?? t("common.untitled")}
          note={event.start.slice(0, 10)}
          onClick={() => ws.openInFocused(event.noteId)}
        />
      ))}
    </>
  );
}

// ── Files: previews, not filenames ──────────────────────────────────────────

function FilesPreviewBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const ws = useWorkspace();
  const rows = useCatalog();
  if (rows === null) return <Empty text={t("notes.home.cards.loading")} />;
  if (rows.length === 0) return <Empty text={t("notes.home.cards.recentFilesEmpty")} />;
  const newest = [...rows].sort((a, b) => b.created_at - a.created_at).slice(0, 6);
  return (
    <div
      data-testid="home.card.files-preview.grid"
      style={{
        display: "grid",
        // A thumbnail is a fixed square, so `auto-fill` is the honest column rule:
        // the widget widens by gaining a column, never by stretching one image.
        gridTemplateColumns: "repeat(auto-fill, 64px)",
        gap: "var(--space-2)",
      }}
    >
      {newest.map((row) => (
        <button
          key={row.id}
          type="button"
          onClick={() => ws.openAttachments()}
          title={row.filename}
          aria-label={row.filename}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            width: 64,
            padding: 0,
            border: "none",
            background: "none",
            cursor: "pointer",
          }}
        >
          <span
            style={{
              width: 64,
              height: 64,
              overflow: "hidden",
              borderRadius: "var(--radius-1)",
              border: "1px solid var(--line-1)",
              background: "var(--bg-2)",
            }}
          >
            <AttachmentThumbnail
              id={row.id}
              contentType={row.content_type}
              filename={row.filename}
              size={64}
            />
          </span>
          <span
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.filename}
          </span>
        </button>
      ))}
    </div>
  );
}

function UnusedFilesBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const ws = useWorkspace();
  const [rows, setRows] = useState<readonly CatalogEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void attachmentUnusedList()
      .then((entries) => {
        if (!cancelled) setRows(entries);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (rows === null) return <Empty text={t("notes.home.cards.loading")} />;
  return (
    <>
      <Stat value={String(rows.length)} label={t("notes.home.cards.filesShort")} />
      <Row
        label={t("notes.home.cards.unusedFilesAction")}
        onClick={() => ws.openAttachments()}
        testId="home.card.unused-files.open"
      />
    </>
  );
}

// ── State ───────────────────────────────────────────────────────────────────

function WritingStatsBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const titles = useTitles();
  return (
    <>
      <Stat value={String(titles.size)} label={t("notes.home.cards.notesShort")} />
      <Stat value={String(prefs.favorites.length)} label={t("notes.home.cards.favoritesShort")} />
    </>
  );
}

function StorageBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const rows = useCatalog();
  if (rows === null) return <Empty text={t("notes.home.cards.loading")} />;
  // The catalog's `size` is what the vault carries, which is the only storage
  // figure this surface can state without asking the filesystem a question it
  // does not own.
  const bytes = rows.reduce((sum, row) => sum + (row.size ?? 0), 0);
  return (
    <>
      <Stat value={formatBytes(bytes)} label={t("notes.home.cards.filesShort")} />
      <Empty text={t("notes.home.cards.storageHint", { count: rows.length })} />
    </>
  );
}

function SyncStatusBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const { status, syncNow, busy } = useSyncStatus();
  // One mapping for every client: the sentence a home widget shows is the same
  // one the sync panel shows (myne-md/myne#1027).
  // `status` is null until the first read resolves, and a story host that never
  // answers leaves it undefined: the shared mapping takes null, so normalise
  // rather than letting a missing field crash the widget.
  // A status SHAPE this build does not know (a newer host, or a host that answers
  // with nothing) leaves the shared mapping with no arm to take and no view to
  // return, and a card that crashes the board over that is worse than one that
  // says nothing. Normalised here rather than in the mapping, because every other
  // consumer renders the mapping's own answer and this one has to survive a host.
  const view = syncStatusView(status ?? null, t) ?? null;
  return (
    <>
      {view === null ? (
        <Empty text={t("notes.home.cards.syncStatusHint")} />
      ) : (
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: view.dotColor,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-1)" }}>{view.label}</span>
      </div>
      )}
      {view !== null && view.syncNowUseful && (
        <Button variant="ghost" disabled={busy} onClick={() => void syncNow()}>
          {t("notes.home.cards.syncNow")}
        </Button>
      )}
    </>
  );
}

// ── AI ──────────────────────────────────────────────────────────────────────

function AgentPromptBody({ card }: { card: HomeCard }) {
  void card;
  const { t } = useTranslation();
  const ws = useWorkspace();
  return (
    <Row
      label={t("notes.home.cards.agentPromptAction")}
      onClick={() => ws.openAgent()}
      testId="home.card.agent-prompt.open"
    />
  );
}

// ── Registry ────────────────────────────────────────────────────────────────

/** One opener per kind that has somewhere deeper to go. */
function openAction(kind: string, ws: ReturnType<typeof useWorkspace>, labels: {
  tasks: string;
  calendar: string;
  files: string;
  agent: string;
  graph: string;
}): { label: string; run: () => void } | null {
  switch (kind) {
    case "todays-tasks":
      return { label: labels.tasks, run: () => ws.openTasks() };
    case "calendar-agenda":
      return { label: labels.calendar, run: () => ws.openCalendar() };
    case "files-preview":
    case "folders":
    case "unused-files":
      return { label: labels.files, run: () => ws.openAttachments() };
    case "agent-prompt":
    case "start-chat":
      return { label: labels.agent, run: () => ws.openAgent() };
    case "graph":
      return { label: labels.graph, run: () => ws.openGraph() };
    default:
      return null;
  }
}

/**
 * The header's trailing control for a widget, when it has one.
 *
 * Icon-only with the label as its accessible name: the header is already the
 * widget's title row, and a second line of text beside it would be the footer
 * button this design just removed.
 */
function CardHeaderAction({ card }: { card: HomeCard }) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const action = openAction(card.kind, ws, {
    tasks: t("notes.home.cards.openTasks"),
    calendar: t("notes.home.cards.openCalendar"),
    files: t("notes.home.cards.openFiles"),
    agent: t("notes.home.cards.openAgent"),
    graph: t("notes.home.cards.openGraph"),
  });
  if (action === null) return null;
  return (
    <button
      type="button"
      onClick={action.run}
      aria-label={action.label}
      title={action.label}
      data-testid={`home.card.open.${card.id}`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 24,
        border: "none",
        borderRadius: "var(--radius-1)",
        background: "transparent",
        color: "var(--fg-3)",
        cursor: "pointer",
      }}
    >
      <Icon name="chevron-right" size={14} />
    </button>
  );
}

/** The renderer for a card kind, or `undefined` for a kind this build cannot draw. */
export const HOME_CARD_DEFS: Readonly<Record<string, HomeCardDef>> = {
  "start-chat": { Body: StartChatBody, HeaderAction: CardHeaderAction },
  "quick-capture": { Body: QuickCaptureBody },
  markdown: { Body: MarkdownBody },
  templates: { Body: TemplatesBody },
  "recent-notes": { Body: RecentNotesBody },
  favorites: { Body: FavoritesBody },
  "saved-views": { Body: SavedViewsBody },
  folders: { Body: FoldersBody, HeaderAction: CardHeaderAction },
  graph: { Body: GraphBody, HeaderAction: CardHeaderAction },
  "todays-tasks": { Body: TodaysTasksBody, HeaderAction: CardHeaderAction },
  "calendar-agenda": { Body: CalendarAgendaBody, HeaderAction: CardHeaderAction },
  "files-preview": { Body: FilesPreviewBody, HeaderAction: CardHeaderAction },
  "unused-files": { Body: UnusedFilesBody, HeaderAction: CardHeaderAction },
  "writing-stats": { Body: WritingStatsBody },
  storage: { Body: StorageBody },
  "sync-status": { Body: SyncStatusBody },
  "agent-prompt": { Body: AgentPromptBody, HeaderAction: CardHeaderAction },
};

export type { HomeCard };
