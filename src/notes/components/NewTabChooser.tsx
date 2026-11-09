// `<NewTabChooser>` — the empty-tab landing surface (MYND-166 behavioral
// pass; reshaped as a start page in myne-md/myne#772). Shown when a pane has no
// active tab, or when the user opens a new tab via the strip's "+". Instead of
// the "+" force-creating a note, this lets the user pick what the tab becomes.
//
// Three layers, top to bottom:
//
// 1. One search over notes AND commands, so "graph" finds the graph and
//    "lecture" finds the lecture note. Enter opens the top row.
// 2. The places row: the destinations a tab can hold (today's note, the agent,
//    attachments, the graph, tasks) as fixed tiles. Fixed rather than learned,
//    so a fresh vault's first new tab is already useful and the tiles never
//    move under a person's hand.
// 3. "Jump back in": notes and commands mixed by recency. Notes carry their own
//    `updatedAt`; commands come from the session's recency store
//    (`lib/commandRecency`), fed by the palette, the rail and key chords.
//
// Places and commands run through `ribbonCommands`, the same bridge the left
// rail uses, so a tile click is the rail click it looks like: same visibility
// rule, same failure toast. Opening an item into the focused pane consumes the
// pending new tab (workspaceContext), so the chosen surface lands HERE.
//
// Notes come from the in-memory sidebar cache (already loaded for the vault),
// filtered to live notes, so picking is instant with no extra IPC.

import { useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { COMMAND_ACTIONS } from "../../commands";
import type { CommandAction } from "../../commands/registry";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import {
  HOVER_TRANSITION,
} from "../../components/primitives/hoverSurface";
import { interactiveSurface } from "../../components/primitives/interactiveSurface";
import { usePrefs } from "../../hooks/usePrefs";
import { useRecentCommandRuns } from "../../lib/commandRecency";
import type { IconName } from "../../lib/icons";
import { archivedFolderKeys } from "../archivedFolders";
import { ribbonCommands } from "../ribbonCommands";
import { liveCache, useSelectedNote, type NoteId } from "../sidebarState";
import { formatRelativeTime, useTick } from "./relativeTime";

type NewTabChooserProps = {
  /** Open an existing note into the new tab. */
  onPick: (id: NoteId) => void;
  /** Create a fresh note into the new tab (then inline-rename it). */
  onCreate: () => void;
  /** Create a fresh drawing (kind: drawing) into the new tab, then inline-rename. */
  onCreateDrawing: () => void;
  /** When true (the pane still has other tabs), Esc returns to the
   *  previously-active tab. A tabless pane has nowhere to fall back to. */
  cancellable: boolean;
  onCancel: () => void;
};

/** The places row, in order. Each is a registry command id plus the short
 *  noun its tile shows; a place whose command is hidden in the current state
 *  (the agent without developer mode) drops out rather than rendering dead. */
export const NEW_TAB_PLACES: readonly {
  id: string;
  icon: IconName;
  labelKey: string;
}[] = [
  { id: "daily.open-today", icon: "calendar-days", labelKey: "notes.newTab.places.today" },
  { id: "ai.open-agent-vault", icon: "message-square", labelKey: "notes.newTab.places.agent" },
  { id: "attachments.open", icon: "paperclip", labelKey: "notes.newTab.places.attachments" },
  { id: "graph.show", icon: "share-2", labelKey: "notes.newTab.places.graph" },
  { id: "tasks.show", icon: "list-todo", labelKey: "notes.newTab.places.tasks" },
  { id: "calendar.show", icon: "calendar", labelKey: "notes.newTab.places.calendar" },
];

/** Commands that never belong in the recent list: the places already have a
 *  tile, and opening the palette is not a destination. */
const NOT_RECENT = new Set<string>([
  ...NEW_TAB_PLACES.map((p) => p.id),
  "palette.open",
  "note.new",
  "note.new-tab",
]);

const RECENT_LIMIT = 8;
const SEARCH_NOTE_LIMIT = 50;
const SEARCH_COMMAND_LIMIT = 6;

type Row =
  | { kind: "note"; key: string; id: NoteId; title: string | null; at: number }
  | { kind: "command"; key: string; action: CommandAction; at: number };

const WRAP: CSSProperties = {
  maxWidth: 640,
  width: "100%",
  margin: "10vh auto 0",
  padding: "0 16px",
  boxSizing: "border-box",
  fontFamily: "var(--font-sans)",
};

const SEARCH_PILL: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  height: 42,
  padding: "0 14px",
  // **Longhands, because the focus state overrides the COLOUR** (review
  // finding): a `border` shorthand beside a `borderColor` is a shorthand and a
  // longhand for the same box property, which React warns about on every
  // rerender and resolves in an order the author did not choose.
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "var(--line-2)",
  borderRadius: "var(--radius-2)",
  background: "var(--bg-2)",
  color: "var(--fg-3)",
  transition: HOVER_TRANSITION,
};

const INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 0,
  outline: "none",
  // Suppress the global `input:focus-visible` ring (tokens.css) — the pill
  // draws the focus state itself, on its border.
  boxShadow: "none",
  background: "transparent",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
};

const PLACES: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))",
  gap: "var(--space-2)",
  marginTop: "var(--space-4)",
};

const PLACE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "var(--space-3)",
  padding: "12px 12px 10px",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  background: "var(--bg-2)",
  color: "var(--fg-1)",
  cursor: "pointer",
  textAlign: "start",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  transition: HOVER_TRANSITION,
};

const SECTION_LABEL: CSSProperties = {
  margin: "var(--space-5) 0 var(--space-1)",
  padding: "0 8px",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const LIST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 1,
  maxHeight: "38vh",
  overflowY: "auto",
};

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  padding: "7px 8px",
  border: 0,
  borderRadius: "var(--radius-1)",
  background: "transparent",
  color: "var(--fg-1)",
  cursor: "pointer",
  textAlign: "start",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  transition: HOVER_TRANSITION,
};

const ROW_ICON: CSSProperties = { display: "flex", flexShrink: 0, color: "var(--fg-3)" };

const ROW_META: CSSProperties = {
  flexShrink: 0,
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const EMPTY: CSSProperties = {
  padding: "12px 8px",
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
};

const CREATE_ROW: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-1)",
  marginTop: "var(--space-3)",
};

const isShown = (id: string): boolean => ribbonCommands.visibility?.(id) === "show";

/** 0 = starts with the query, 1 = contains it, null = no match. */
function matchTier(text: string, q: string): 0 | 1 | null {
  const s = text.toLowerCase();
  if (s.startsWith(q)) return 0;
  return s.includes(q) ? 1 : null;
}

export function NewTabChooser({
  onPick,
  onCreate,
  onCreateDrawing,
  cancellable,
  onCancel,
}: NewTabChooserProps) {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  const { prefs } = usePrefs();
  const commandRuns = useRecentCommandRuns();
  // Re-render on the shared relative-time tick so "2 min ago" stays true.
  useTick();
  const [query, setQuery] = useState("");
  // Inline styles can't express `:focus-within`, so the pill tracks it.
  const [searchFocused, setSearchFocused] = useState(false);

  const archivedKeys = useMemo(
    () => archivedFolderKeys(prefs.archived_folders),
    [prefs.archived_folders],
  );

  // `liveCache` is the canonical trash/template/archive visibility predicate
  // (sidebarState); reuse it so this picker can't silently diverge.
  const notes = useMemo(
    () =>
      [...liveCache(ctx.cache, archivedKeys).values()].sort(
        (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
      ),
    [ctx.cache, archivedKeys],
  );

  // Visibility is read at render: prefs changes (developer mode, AI) re-render
  // this component through `usePrefs`, which is when the answer can change.
  const places = NEW_TAB_PLACES.filter((p) => isShown(p.id));
  const canTemplate = isShown("templates.new-note");

  const q = query.trim().toLowerCase();
  const rows = useMemo<Row[]>(() => {
    const noteRow = (r: (typeof notes)[number]): Row => ({
      kind: "note",
      key: `n:${r.noteUuid}`,
      id: r.noteUuid,
      title: r.title,
      at: r.updatedAt?.getTime() ?? 0,
    });
    const runAt = new Map(commandRuns.map((r) => [r.id, r.at]));

    if (q === "") {
      const recentCommands: Row[] = [];
      for (const run of commandRuns) {
        if (NOT_RECENT.has(run.id)) continue;
        const action = COMMAND_ACTIONS.find((a) => a.id === run.id);
        if (action === undefined || !isShown(action.id)) continue;
        recentCommands.push({ kind: "command", key: `c:${action.id}`, action, at: run.at });
      }
      return [...notes.slice(0, RECENT_LIMIT).map(noteRow), ...recentCommands]
        .sort((a, b) => b.at - a.at)
        .slice(0, RECENT_LIMIT);
    }

    // Searching: prefix matches outrank substring matches, then recency. A
    // command nobody has run yet sorts after every one that has, within its tier.
    const scored: { row: Row; tier: 0 | 1 }[] = [];
    let noteCount = 0;
    for (const r of notes) {
      if (noteCount >= SEARCH_NOTE_LIMIT) break;
      const tier = matchTier(r.title ?? "", q);
      if (tier === null) continue;
      noteCount += 1;
      scored.push({ row: noteRow(r), tier });
    }
    let commandCount = 0;
    for (const action of COMMAND_ACTIONS) {
      if (commandCount >= SEARCH_COMMAND_LIMIT) break;
      if (action.id === "palette.open" || !isShown(action.id)) continue;
      const tier = matchTier(action.label, q);
      if (tier === null) continue;
      commandCount += 1;
      scored.push({
        row: { kind: "command", key: `c:${action.id}`, action, at: runAt.get(action.id) ?? 0 },
        tier,
      });
    }
    return scored
      .sort((a, b) => a.tier - b.tier || b.row.at - a.row.at)
      .map((s) => s.row);
    // `prefs` is a dependency for the visibility reads above.
  }, [notes, commandRuns, q, prefs]);

  const runCommand = (id: string) => ribbonCommands.run?.(id);
  const openRow = (row: Row) =>
    row.kind === "note" ? onPick(row.id) : runCommand(row.action.id);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (cancellable && e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    // Enter opens the top row — the search doubles as go-to-anything.
    if (e.key === "Enter" && rows.length > 0) {
      e.preventDefault();
      openRow(rows[0]!);
    }
  };

  const meta = (row: Row): string => {
    const kind =
      row.kind === "note" ? t("notes.newTab.kindNote") : t("notes.newTab.kindCommand");
    const when = row.at > 0 ? formatRelativeTime(new Date(row.at)) : "";
    return when === "" ? kind : `${kind} · ${when}`;
  };

  return (
    <div style={WRAP} onKeyDown={onKeyDown} data-testid="notes.newTab">
      <div
        style={{
          ...SEARCH_PILL,
          ...(searchFocused ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}),
        }}
      >
        <Icon name="search" size={15} />
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          placeholder={t("notes.newTab.searchPlaceholder")}
          spellCheck={false}
          autoComplete="off"
          aria-label={t("notes.newTab.searchAriaLabel")}
          data-testid="notes.newTab.search"
          style={INPUT}
        />
      </div>

      {q === "" && places.length > 0 && (
        <div style={PLACES} role="group" aria-label={t("notes.newTab.placesLabel")}>
          {places.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => runCommand(p.id)}
              data-testid={`notes.newTab.place.${p.id}`}
              {...interactiveSurface()}
              style={PLACE}
            >
              <span
                style={{
                  display: "flex",
                  color: p.id === "daily.open-today" ? "var(--accent)" : "var(--fg-2)",
                }}
              >
                <Icon name={p.icon} size={18} />
              </span>
              <span>{t(p.labelKey)}</span>
            </button>
          ))}
        </div>
      )}

      <div style={SECTION_LABEL}>
        {q === "" ? t("notes.newTab.recent") : t("notes.newTab.results")}
      </div>
      <div style={LIST}>
        {rows.length === 0 ? (
          <div style={EMPTY}>
            {q === "" ? t("notes.newTab.noNotesYet") : t("notes.newTab.noMatch")}
          </div>
        ) : (
          rows.map((row) => (
            <button
              key={row.key}
              type="button"
              onClick={() => openRow(row)}
              data-testid={
                row.kind === "note" ? "notes.newTab.note-row" : "notes.newTab.command-row"
              }
              {...interactiveSurface()}
              style={ROW}
            >
              <span style={ROW_ICON}>
                <Icon
                  name={
                    row.kind === "note" ? "file-text" : (row.action.ribbon?.icon ?? "command")
                  }
                  size={14}
                />
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  ...(row.kind === "note" && row.title === null
                    ? { fontStyle: "italic", color: "var(--fg-3)" }
                    : null),
                }}
              >
                {row.kind === "note"
                  ? (row.title ?? t("common.untitled"))
                  : row.action.label}
              </span>
              <span style={ROW_META}>{meta(row)}</span>
            </button>
          ))
        )}
      </div>

      <div style={CREATE_ROW}>
        <Button variant="ghost" icon="plus" onClick={onCreate} data-testid="notes.newTab.create-note">
          {t("notes.newTab.createNote")}
        </Button>
        <Button
          variant="ghost"
          icon="pencil"
          onClick={onCreateDrawing}
          data-testid="notes.newTab.create-drawing"
        >
          {t("notes.newTab.createDrawing")}
        </Button>
        {canTemplate && (
          <Button
            variant="ghost"
            icon="file-plus"
            onClick={() => runCommand("templates.new-note")}
            data-testid="notes.newTab.create-from-template"
          >
            {t("notes.newTab.createFromTemplate")}
          </Button>
        )}
      </div>
    </div>
  );
}
