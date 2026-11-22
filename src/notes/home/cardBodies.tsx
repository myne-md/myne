// The home surface's eleven card bodies (myne-md/myne#1074, task 14).
//
// ── The one rule ────────────────────────────────────────────────────────────
// **A card never owns its data.** Every body here reads the module that already
// answers its question — `recentNoteIds`, `prefs.favorites`, `useLiveVaultTasks`,
// `useLiveCalendarEvents`, the attachment catalog, the title cache — and renders
// a bounded summary plus a way into the full surface. A card with its own query
// is a second answer to a question the app already answers, and the two drift the
// first time only one of them is touched.
//
// ── Empty states are part of the contract ───────────────────────────────────
// A card on an empty vault must say what it would show rather than render
// nothing: "no data yet" and "this card is broken" look identical otherwise, and
// the empty vault is one of the three synthetic profiles the plan verifies
// against.

import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { catalogList, type CatalogEntry } from "../../lib/attachments";
import { usePrefs } from "../../hooks/usePrefs";
import { useLiveCalendarEvents } from "../../hooks/useLiveCalendarEvents";
import { useSelectedNoteOptional } from "../sidebarState";
import { useLiveVaultTasks } from "../taskIndex";
import { useWorkspace } from "../workspaceContext";
import { createNote } from "../createNote";
import { recentNoteIds } from "../recentNotes";

/** How many rows a card shows before it stops being a summary. */
const MAX_ROWS = 5;

/** One row: a label and what it is, in the app's voice. */
function Row({
  label,
  note,
  onClick,
  testId,
}: {
  label: string;
  note?: string;
  onClick?: () => void;
  testId?: string;
}) {
  // A raw `<button>` and not the primitive, on purpose: this is a bare LIST ROW,
  // and the primitive's variants carry button chrome (border, padding, hover
  // surface) that a row inside a card must not have. The row keeps its own focus
  // ring through the app's global control styles (myne-md/myne#1074).
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={onClick === undefined}
      data-testid={testId}
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: "var(--space-2)",
        width: "100%",
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
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      {note !== undefined && (
        <span style={{ flexShrink: 0, color: "var(--fg-3)", fontSize: "var(--text-xs)" }}>
          {note}
        </span>
      )}
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)", lineHeight: 1.5 }}>
      {text}
    </div>
  );
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

function RecentNotesCard() {
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

function FavoritesCard() {
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

function TodaysTasksCard() {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const tasks = useLiveVaultTasks();
  const open = tasks.filter((task) => !task.completed).slice(0, MAX_ROWS);
  if (open.length === 0) {
    return (
      <>
        <Empty text={t("notes.home.cards.todaysTasksEmpty")} />
        <Button variant="ghost" onClick={() => ws.openTasks()}>
          {t("notes.home.cards.openTasks")}
        </Button>
      </>
    );
  }
  return (
    <>
      {open.map((task) => (
        <Row
          key={`${task.noteId}:${task.lineIndex ?? "note"}`}
          label={task.rawLine.replace(/^[-*]\s*\[.\]\s*/, "").slice(0, 80)}
          note={task.noteTitle ?? undefined}
          onClick={() => ws.openInFocused(task.noteId)}
        />
      ))}
      <Button variant="ghost" onClick={() => ws.openTasks()}>
        {t("notes.home.cards.openTasks")}
      </Button>
    </>
  );
}

function CalendarAgendaCard() {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const titles = useTitles();
  // An occurrence carries the note it belongs to and when it starts, not a
  // title: the title lives in the cache, the same place a tab label reads it.
  const events = useLiveCalendarEvents(7).slice(0, MAX_ROWS);
  if (events.length === 0) {
    return (
      <>
        <Empty text={t("notes.home.cards.calendarAgendaEmpty")} />
        <Button variant="ghost" onClick={() => ws.openCalendar()}>
          {t("notes.home.cards.openCalendar")}
        </Button>
      </>
    );
  }
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
      <Button variant="ghost" onClick={() => ws.openCalendar()}>
        {t("notes.home.cards.openCalendar")}
      </Button>
    </>
  );
}

/**
 * An attachment's folder, when this build's catalog carries it.
 *
 * The field is added by myne-md/myne#1078, which this branch is not stacked on.
 * Read through one helper rather than a cast per use, so the day the two land
 * together the helper is what changes and nothing else has to be found.
 */
function folderOf(row: CatalogEntry): string {
  return (row as { folder?: string }).folder ?? "";
}

/** The attachment catalog, read once per mount: the same command the library uses. */
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

function RecentFilesCard() {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const rows = useCatalog();
  if (rows === null) return <Empty text={t("notes.home.cards.loading")} />;
  if (rows.length === 0) {
    return (
      <>
        <Empty text={t("notes.home.cards.recentFilesEmpty")} />
        <Button variant="ghost" onClick={() => ws.openAttachments()}>
          {t("notes.home.cards.openFiles")}
        </Button>
      </>
    );
  }
  const newest = [...rows].sort((a, b) => b.created_at - a.created_at).slice(0, MAX_ROWS);
  return (
    <>
      {newest.map((row) => (
        <Row
          key={row.id}
          label={row.filename}
          note={folderOf(row) === "" ? undefined : folderOf(row)}
          onClick={() => ws.openAttachments()}
        />
      ))}
      <Button variant="ghost" onClick={() => ws.openAttachments()}>
        {t("notes.home.cards.openFiles")}
      </Button>
    </>
  );
}

function ReferenceSetsCard() {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const rows = useCatalog();
  if (rows === null) return <Empty text={t("notes.home.cards.loading")} />;
  // A reference set IS a folder: one namespace for typed notes and imported
  // files, so the card counts what each folder holds rather than inventing a
  // second grouping (myne-md/myne#1075).
  const counts = new Map<string, number>();
  for (const row of rows) {
    const folder = folderOf(row);
    if (folder === "") continue;
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  const folders = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ROWS);
  if (folders.length === 0) {
    return (
      <>
        <Empty text={t("notes.home.cards.referenceSetsEmpty")} />
        <Button variant="ghost" onClick={() => ws.openAttachments()}>
          {t("notes.home.cards.openFiles")}
        </Button>
      </>
    );
  }
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

function SavedViewsCard() {
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

function WritingStatsCard() {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const titles = useTitles();
  // Words and notes are two different facts and both are cheap here: the cache
  // already holds every title, and the vault's note count is its size.
  const notes = titles.size;
  return (
    <>
      <Row label={t("notes.home.cards.statNotes", { count: notes })} />
      <Row
        label={t("notes.home.cards.statFavorites", { count: prefs.favorites.length })}
      />
      <Empty text={t("notes.home.cards.writingStatsHint")} />
    </>
  );
}

function QuickCaptureCard() {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const [busy, setBusy] = useState(false);
  // **A fresh note, opened where you are.** Not a second write path: `createNote`
  // is the same helper the "+ New note" action calls, so the note this makes is
  // indistinguishable from one made anywhere else. Prefilling it with typed text
  // would be a new write path for a card, which the plan puts out of scope.
  const startFreshNote = () => {
    if (busy) return;
    setBusy(true);
    void createNote(null)
      .then((id) => ws.openInFocused(id))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Empty text={t("notes.home.cards.quickCaptureHint")} />
      <Button
        variant="secondary"
        icon="file-plus"
        onClick={startFreshNote}
        disabled={busy}
        data-testid="home.card.quick-capture.new"
      >
        {t("common.newnote")}
      </Button>
    </>
  );
}

function AgentPromptCard() {
  const { t } = useTranslation();
  const ws = useWorkspace();
  return (
    <>
      <Empty text={t("notes.home.cards.agentPromptHint")} />
      <Button variant="secondary" icon="message-square" onClick={() => ws.openAgent()}>
        {t("notes.home.cards.agentPromptAction")}
      </Button>
    </>
  );
}

function GraphCard() {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const titles = useTitles();
  // Decoration, and the plan says so: a small picture of the vault rather than a
  // working surface. It reports the one number it can know honestly (how many
  // notes the graph would draw) and hands you the real graph.
  return (
    <>
      <Empty text={t("notes.home.cards.graphCount", { count: titles.size })} />
      <Button variant="ghost" onClick={() => ws.openGraph()}>
        {t("notes.home.cards.openGraph")}
      </Button>
    </>
  );
}

/** The renderer for a card kind, or `undefined` for a kind this build cannot draw. */
export const HOME_CARD_BODIES: Readonly<Record<string, () => ReactElement>> = {
  "recent-notes": RecentNotesCard,
  favorites: FavoritesCard,
  "todays-tasks": TodaysTasksCard,
  "calendar-agenda": CalendarAgendaCard,
  "recent-files": RecentFilesCard,
  "reference-sets": ReferenceSetsCard,
  "saved-views": SavedViewsCard,
  "writing-stats": WritingStatsCard,
  "quick-capture": QuickCaptureCard,
  "agent-prompt": AgentPromptCard,
  graph: GraphCard,
};
