// `<NoteRow>` — single sidebar list row.
//
// Visual canon from the 2026-05-15 Penpot pass (`flow--notes-sidebar`
// board, frames `populated` + `rename`). Token alignments per
// `decisions.md` 2026-05-15 "Sidebar virtualization" + `PRODUCT.md`
// design principles 4 (calm) + 5 (plain-markdown portability) +
// DESIGN.md "one accent rule".
//
// PRD stories: 3 (FM title), 4 (H1 fallback), 5 (Untitled italic
// placeholder), 6 (relative-time subtitle), 7 (UUIDv7 fallback), 33
// (CSS `text-overflow: ellipsis` — load-bearing per user feedback
// 2026-05-15: titles MUST be single-line), 80 (component shape).
//
// T20 inline-rename mode is a state variant of this same component:
// when `renamingId === id`, the title text node is replaced by an
// `<input>` with auto-focus + select-all. Row outer dimensions stay
// identical (no layout shift; subtitle stays anchored).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { labelColorVar } from "../decorations";
import type { TitleRecord } from "../loadNoteBatch";
import { TASK_KIND_VALUE } from "../../dialect";
import { uuidv7Ms } from "../sidebarState";
import { Icon } from "../../components/primitives/Icon";
import { StatusMark } from "../../components/Spinner";
import { formatRelativeTime, useTick } from "./relativeTime";

export type NoteRowProps = {
  record: TitleRecord;
  selected: boolean;
  renaming: boolean;
  /** Click handler → caller dispatches the row's activation intent.
   *  The modifier matrix (MYND-166 + MYND-367 multi-select):
   *  - plain click → `{}` (open in the focused pane; collapses any set)
   *  - Cmd/Ctrl-click → `{ toggle: true }` (toggle multi-selection; no open)
   *  - Shift-click → `{ range: true }` (range-select from anchor; no open)
   *  - Alt-click → `{ toSide: true }` (split to the side)
   *  - middle-click → `{ newTab: true }` (open in a new tab)
   *  Cmd/Ctrl no longer means "new tab" — that demoted to middle-click + the
   *  "Open in new tab" context-menu item so cmd-click is free for multi-select. */
  onSelect: (
    id: string,
    opts?: { newTab?: boolean; toSide?: boolean; toggle?: boolean; range?: boolean },
  ) => void;
  /** Double-click on title → enter inline-rename mode. */
  onStartRename: (id: string) => void;
  /** Right-click → caller surfaces context menu. */
  onContextMenu: (id: string, position: { x: number; y: number }) => void;
  /** Inline-rename commit (Enter or blur). Caller orchestrates surgery
   *  + IPC via `useSelectedNote().commitRename`. */
  onCommitRename: (id: string, trimmedNewTitle: string) => void;
  /** Inline-rename cancel (Esc). */
  onCancelRename: () => void;
  /** Whether this note is in the Favorites list — drives the star state
   *  (filled vs hover-outline). MYND-183. */
  favorited?: boolean;
  /** Toggle favorite membership (star click). When omitted the star is a
   *  non-interactive filled badge shown only on favorited rows (render-only;
   *  the toggle handler is wired in the favorites-membership task). */
  onToggleFavorite?: (id: string) => void;
  /** Color-label slot (MYND-184) — washes the row's background (MYND-627,
   *  replacing the leading dot) before the
   *  title. Undefined when the note has no color. */
  colorSlot?: string;
  /** Whether this row is part of the active multi-selection (MYND-367) — paints
   *  the same accent-soft fill as `selected` so the whole set reads as picked,
   *  and exposes `data-multiselected` for E2E. Orthogonal to `selected` (the
   *  single open-in-pane note). */
  multiSelected?: boolean;
  /** Whether to render the relative-time subtitle line (sidebar-note-timestamps).
   *  Defaults to `true` (the pre-feature behaviour). When `false` the subtitle
   *  `<div>` is omitted entirely and the title vertically centers in the row's
   *  fixed `minHeight`. Driven by `PrefsView.show_note_timestamps`. */
  showTimestamps?: boolean;
  /** Whether this note is its folder's **index note** (MYND-370) — the
   *  authoritative winner pinned by `FolderNode.indexNoteId`, threaded from
   *  NoteList. Renders a subtle index badge after the title. Distinct from
   *  `record.folderIndex`, which can't tell a conflict loser from the winner. */
  isIndexNote?: boolean;
  /** Whether the note-task marker is shown (MYND-613, `show_task_marker`).
   *  Threaded from NoteList rather than read per row — the list already holds a
   *  `usePrefs` instance and a hook per row would be wasteful. */
  showTaskMarker?: boolean;
  /** Whether this note CLAIMED `folder_index: true` but lost the deterministic
   *  tiebreak (its id is in `FolderNode.indexConflictIds`, MYND-370). Surfaces a
   *  muted "folder already has an index" indicator so the user can resolve it. */
  indexConflict?: boolean;
  /** Whether this note's current bytes are **not yet on the server**
   *  (phase3-web-client task 23). Distinct from the save status in the bottom
   *  bar, which is about the local disk — a note can be saved and still be the
   *  only copy in existence. Only ever true when sync is configured; a client
   *  that was never asked to sync marks nothing. */
  unsynced?: boolean;
};

// ─── Token-bound style constants ──────────────────────────────────
//
// Style maps live as module constants so React doesn't recreate
// objects per render. CSS variables resolve at runtime via the
// app-level `colors_and_type.css` import.

const rowBaseStyle: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "8px 14px",
  minHeight: 52,
  cursor: "pointer",
  borderRadius: "var(--radius-2)",
  marginInlineStart: 4,
  marginInlineEnd: 4,
  // Never grow past the sidebar: the flex content shrinks + the title ellipsizes
  // (rowContentStyle clips) instead of the whole pill bleeding under the editor.
  minWidth: 0,
  overflow: "hidden",
  // A small vertical gap so adjacent highlighted rows (hover + selected) don't
  // butt their backgrounds together and blend — each row reads as its own
  // rounded pill. Single-direction (bottom only) → a deterministic 3px gap
  // regardless of flex/block margin-collapse; the row above supplies the gap
  // above each row. Matched by `FolderRow` so the interleaved tree is uniform.
  marginBottom: 3,
  // Subtle hover via inline `:hover` not possible without a stylesheet —
  // we toggle via state below (`hovering`) so design-token bg shifts
  // are explicit.
};

/** Compact override applied when the timestamp subtitle is hidden
 *  (sidebar-note-timestamps OFF): a single-line title needs far less vertical
 *  room than the title+subtitle stack, so the row tightens to roughly the
 *  FolderRow height (30px) instead of dwelling at the two-line `minHeight`. */
const rowCompactStyle: CSSProperties = {
  padding: "4px 14px",
  minHeight: 30,
};

/** Inner column (title + subtitle), so the star affordance can sit to the
 *  right of the row without disturbing the stacked text. */
const rowContentStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 2,
  flex: 1,
  minWidth: 0,
  // Clip the stacked title/subtitle to this column so a long title ELLIPSIZES
  // (titleStyle is nowrap) instead of pushing the row wider than the sidebar —
  // which bled the hover/active pill under the editor and shoved the star
  // affordance off-screen on hover. With the column bounded, the star always
  // has room (it flex-shrink:0 reserves its slot, the title truncates to fit).
  overflow: "hidden",
};

/** Right-aligned star affordance — favorite indicator / toggle (MYND-183). */
const starButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: 22,
  height: 22,
  padding: 0,
  background: "transparent",
  border: 0,
  borderRadius: "var(--radius-1)",
  cursor: "pointer",
};

/** Lucide `star` — `filled` paints the accent fill (favorited); otherwise a
 *  hollow ink-3 outline (hover-to-favorite). Inline like FolderRow's icons so
 *  the fill/outline split is local. */
function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

const rowSelectedStyle: CSSProperties = {
  background: "var(--accent-soft)",
};

const rowHoverStyle: CSSProperties = {
  background: "var(--paper-3)",
};

const titleStyle: CSSProperties = {
  // Load-bearing per 2026-05-15 user feedback: titles MUST be single
  // line. The PRD already pinned this (stories 33 + 80) but the
  // Penpot frame visually wrapped; this CSS contract overrides.
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  color: "var(--fg-1)",
  lineHeight: 1.35,
};

const titleUntitledStyle: CSSProperties = {
  ...titleStyle,
  fontStyle: "italic",
  color: "var(--fg-3)",
  fontWeight: "var(--weight-regular)",
};

const subtitleStyle: CSSProperties = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-regular)",
  color: "var(--fg-3)",
  lineHeight: 1.3,
};

const errorIndicatorStyle: CSSProperties = {
  display: "inline-block",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--warning)",
  marginInlineEnd: 6,
  verticalAlign: "middle",
};

/** Folder-index badge (MYND-370) — a small muted open-book glyph trailing the
 *  title on the folder's index note. Subtle by design (PRODUCT.md calm tone):
 *  `fg-3` ink, no fill, no accent. */
/** Note-task marker (MYND-613) — a muted trailing glyph on a `kind: task` note.
 *  Same treatment as the index badge: `--fg-3`, 12px, inline after the title. It
 *  marks the note as a task and says nothing about completion — no check state,
 *  and no green check, which the canon prohibits. */
const taskBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  marginInlineStart: 6,
  color: "var(--fg-3)",
  verticalAlign: "middle",
};

const indexBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  marginInlineStart: 6,
  color: "var(--fg-3)",
  verticalAlign: "middle",
};

/** Index-conflict indicator (MYND-370) — a muted warning dot trailing the title
 *  on a note that claimed `folder_index: true` but lost the tiebreak. Muted
 *  (`line-3`, not the loud `--warning`) so it reads as "FYI, this folder already
 *  has an index" rather than an error. */
const indexConflictStyle: CSSProperties = {
  display: "inline-block",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--line-3)",
  marginInlineStart: 6,
  verticalAlign: "middle",
};

/** Unsynced-edit marker (phase3-web-client task 23), at the row's trailing edge
 *  on a note the server has not acknowledged. Row-level, not title-level:
 *  inline-rename swaps the title node out, and the marker must survive that.
 *
 *  **`cloud-off`, and it took three tries to get here.** It was a closed 6px
 *  ring, and at that size a ring and a dot are the same glyph, which is what it
 *  was reported as: a mark nobody could read anything off (myne-md/myne#566). It
 *  became the save readout's own arc, which was the same mistake one level up,
 *  two facts wearing one glyph, adjacent on the bottom bar. It became a solid
 *  triangle, which at least was distinct, and depicted nothing, so down a column
 *  of rows it read as a bullet point (myne-md/myne#603).
 *
 *  What the first three shared is that each was hand-drawn geometry small enough
 *  to be unlearnable. A cloud with a slash is a picture of the sentence, at 12px
 *  because that is where an icon starts being an icon, and 12px is what this row
 *  already draws its other icons at.
 *
 *  It never TURNS, and that is a design-canon decision rather than an oversight.
 *  `docs/design/README.md` bans looping animation by name, and the sidebar draws
 *  one of these per unsynced note: a screenful of marks moving together is the
 *  ambient motion that rule exists to keep out of a writing surface. Motion stays
 *  where the work is bounded and there is one of it, the save readout in the
 *  bottom bar. This mark says "the server does not have this", which is true
 *  whether the machine is online or has been shut for a week.
 *
 *  It carries no style of its own, and the object that used to sit here is gone
 *  rather than emptied: the row is `display: flex` with `gap: var(--space-2)`,
 *  so its `margin-inline-start: 6` ADDED to that and put the mark 14px from the
 *  title block rather than 8, and its `vertical-align: middle` does nothing
 *  whatever to a flex item. The row's own gap and `align-items: center` are what
 *  place it (myne-md/myne#603). */

const renameInputStyle: CSSProperties = {
  display: "block",
  width: "100%",
  // border-box + width:100% so the field fits EXACTLY inside the row instead of
  // overflowing it (the old content-box + negative horizontal margins pushed the
  // box past the row edge — the "off" look). Only a small negative VERTICAL
  // margin remains, to keep the row from growing taller while renaming.
  boxSizing: "border-box",
  // Clean inline-edit look: no hard accent border — just a subtle fill and ONE
  // soft accent halo, replacing the old accent-border-PLUS-global-focus-ring
  // double outline. The inline `boxShadow` overrides the global `:focus-visible`
  // `--ring` (inline wins), so there is a single, quiet ring.
  border: "1px solid transparent",
  borderRadius: "var(--radius-1, 4px)",
  padding: "1px 6px",
  margin: "-2px 0",
  background: "var(--bg-2)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  lineHeight: 1.35,
  outline: "none",
  boxShadow: "0 0 0 2px var(--accent-soft)",
};

// ─── Component ────────────────────────────────────────────────────

export function NoteRow(props: NoteRowProps) {
  const { t } = useTranslation();
  const {
    record,
    selected,
    renaming,
    onSelect,
    onStartRename,
    onContextMenu,
    onCommitRename,
    onCancelRename,
    favorited = false,
    onToggleFavorite,
    colorSlot,
    showTimestamps = true,
    multiSelected = false,
    isIndexNote = false,
    indexConflict = false,
    unsynced = false,
    showTaskMarker = true,
  } = props;

  const [hovering, setHovering] = useState(false);
  // Star shows when favorited (filled badge) or, when the toggle is wired,
  // on hover (hollow outline = "add to favorites"). Hidden during rename.
  const showStar =
    !renaming && (favorited || (onToggleFavorite !== undefined && hovering));
  // 30s shared tick — re-renders relative-time strings.
  useTick();

  const effectiveDate = useMemo(() => {
    if (record.updatedAt !== null) return record.updatedAt;
    const ms = uuidv7Ms(record.noteUuid);
    return ms === null ? null : new Date(ms);
  }, [record.updatedAt, record.noteUuid]);

  const subtitleText = effectiveDate !== null ? formatRelativeTime(effectiveDate) : "";

  // Timestamp of the last contextmenu on this row. Some engines synthesise a
  // primary-button `click` (button === 0) immediately after a right-click; that
  // phantom click must NOT run the plain-open path, or it would clear an
  // in-progress multi-selection just as the bulk context menu opens (the menu
  // would then see a single selection). A right-click sets this; handleClick
  // ignores a click that lands within a tick of it.
  const lastContextMenuAt = useRef<number>(0);

  const handleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // Primary button only — a non-primary press (right-click → context menu,
      // middle-click → new tab via onAuxClick) must not also open the note.
      if (e.button !== 0) return;
      // Suppress a phantom primary-button click synthesised right after a
      // right-click (observed under WebKit: the contextmenu's trailing click
      // reports button 0). 300 ms covers the synth latency without affecting a
      // genuine later left-click.
      if (performance.now() - lastContextMenuAt.current < 300) return;
      // Modifier matrix (MYND-166 + MYND-367). Shift / Cmd-Ctrl are
      // multi-select gestures that must NOT open the note; Alt splits; plain
      // opens in the focused pane. Shift takes precedence over Cmd/Ctrl so a
      // Shift+Cmd chord ranges (the conventional list behavior).
      if (e.shiftKey) {
        e.preventDefault();
        onSelect(record.noteUuid, { range: true });
      } else if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        onSelect(record.noteUuid, { toggle: true });
      } else {
        onSelect(record.noteUuid, { toSide: e.altKey });
      }
    },
    [onSelect, record.noteUuid],
  );

  // Middle-click also opens in a new tab.
  const handleAuxClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.button === 1) {
        e.preventDefault();
        onSelect(record.noteUuid, { newTab: true });
      }
    },
    [onSelect, record.noteUuid],
  );

  const handleDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // Double-click on the title region → inline-rename.
      e.preventDefault();
      onStartRename(record.noteUuid);
    },
    [onStartRename, record.noteUuid],
  );

  const handleContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      lastContextMenuAt.current = performance.now();
      onContextMenu(record.noteUuid, { x: e.clientX, y: e.clientY });
    },
    [onContextMenu, record.noteUuid],
  );

  // A multi-selected row paints the same accent-soft fill as the open row, so
  // the whole gathered set reads as picked (MYND-367).
  const highlighted = selected || multiSelected;
  // MYND-627: a coloured note washes its ROW rather than carrying a dot.
  // The dot spent a fixed slice of width on every coloured row -- costly in a
  // narrow sidebar, worse on mobile -- and read as a bullet rather than as the
  // note being marked. A highlight-style wash costs no width at all. Kept low
  // enough in alpha to sit under the selected/hover fills without muddying
  // them, and the title text stays in the ink ramp, so PRODUCT.md's rule that
  // colour never tints prose still holds.
  const colorWash =
    colorSlot && !highlighted
      ? {
          background: `color-mix(in srgb, ${labelColorVar(colorSlot)} 14%, transparent)`,
        }
      : {};
  const composedRowStyle: CSSProperties = {
    ...rowBaseStyle,
    ...(showTimestamps ? {} : rowCompactStyle),
    ...colorWash,
    ...(highlighted ? rowSelectedStyle : hovering ? rowHoverStyle : {}),
  };

  return (
    <div
      style={composedRowStyle}
      // Marker for the row's colour label — the paint is the wash above, but
      // this is what E2E and the component tests locate it by.
      data-color-slot={colorSlot}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      data-testid="notes.row"
      data-note-id={record.noteUuid}
      data-multiselected={multiSelected ? "true" : undefined}
      role="button"
      // `aria-selected` is not a permitted attribute on role="button"; use
      // `aria-current` to convey the highlighted/active row in the list instead.
      aria-current={highlighted ? "true" : undefined}
      tabIndex={-1}
    >
      <div style={rowContentStyle}>
        {renaming ? (
          <NoteRowRenameInput
            initialValue={record.title ?? ""}
            onCommit={(v) => onCommitRename(record.noteUuid, v)}
            onCancel={onCancelRename}
          />
        ) : (
          <TitleLine
            record={record}
            isIndexNote={isIndexNote}
            indexConflict={indexConflict}
            showTaskMarker={showTaskMarker}
          />
        )}
        {showTimestamps && (
          <div style={subtitleStyle} data-testid="notes.row-subtitle">
            {subtitleText}
          </div>
        )}
      </div>
      {/* Unsynced-edit marker (phase3-web-client task 23) — a ROW-level node,
          deliberately outside the title/rename swap above. Its first draft sat
          inside `TitleLine`, so entering inline-rename mode removed it: a note
          does not become safe because the user is retitling it, and that is
          exactly the moment the sidebar is being looked at. */}
      {unsynced && (
        <StatusMark
          name="cloud-off"
          testId="notes.row-unsynced"
          label={t("notes.row.unsyncedLabel")}
          title={t("notes.row.unsyncedTitle")}
        />
      )}
      {showStar &&
        (onToggleFavorite !== undefined ? (
          <button
            type="button"
            style={{
              ...starButtonStyle,
              color: favorited ? "var(--accent)" : "var(--fg-3)",
            }}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(record.noteUuid);
            }}
            aria-label={
              favorited
                ? t("notes.row.removeFromFavorites")
                : t("notes.row.addToFavorites")
            }
            title={
              favorited
                ? t("notes.row.removeFromFavorites")
                : t("notes.row.addToFavorites")
            }
          >
            <StarIcon filled={favorited} />
          </button>
        ) : (
          <span
            style={{ ...starButtonStyle, cursor: "default", color: "var(--accent)" }}
            aria-hidden="true"
          >
            <StarIcon filled />
          </span>
        ))}
    </div>
  );
}

// ─── TitleLine — handles Untitled placeholder + error indicator ───

// Colour no longer reaches the title: MYND-627 moved it to the row's own wash,
// so this renders text and trailing markers only.
function TitleLine({
  record,
  isIndexNote = false,
  indexConflict = false,
  showTaskMarker = true,
}: {
  record: TitleRecord;
  isIndexNote?: boolean;
  indexConflict?: boolean;
  showTaskMarker?: boolean;
}) {
  const { t } = useTranslation();
  // Trailing markers (MYND-370) — the index badge on the folder's index note,
  // and the muted conflict dot on a claimant that lost the tiebreak. Both are
  // subtle, inline-after-title, and mutually exclusive in practice (a winner is
  // never a conflict loser).
  //
  // MYND-613 adds a third: the note-task marker. It rides the same muted
  // trailing-glyph treatment rather than inventing a second visual language, and
  // deliberately carries **no completion styling** — no check state, and above
  // all no green check, which the design canon prohibits. The marker says "this
  // note is a task", not "this task is done"; whether it should change once the
  // task completes is a separate design question this slice leaves open.
  const markers = (
    <>
      {showTaskMarker && record.kind === TASK_KIND_VALUE && (
        <span
          style={taskBadgeStyle}
          data-testid="notes.row-task-badge"
          title={t("notes.row.taskBadgeTitle")}
          aria-label={t("notes.row.taskBadgeLabel")}
        >
          <Icon name="list" size={12} />
        </span>
      )}
      {isIndexNote && (
        <span
          style={indexBadgeStyle}
          data-testid="notes.row-folder-index-badge"
          title={t("notes.row.folderIndexBadgeTitle")}
          aria-label={t("notes.row.folderIndexBadgeLabel")}
        >
          <Icon name="book-open" size={12} />
        </span>
      )}
      {indexConflict && (
        <span
          style={indexConflictStyle}
          data-testid="notes.folder-index-conflict"
          title={t("notes.row.folderIndexConflictTitle")}
          aria-label={t("notes.row.folderIndexConflictLabel")}
        />
      )}
    </>
  );
  if (record.error !== undefined) {
    return (
      <div style={titleUntitledStyle} title={t("notes.row.loadError")}>
        <span style={errorIndicatorStyle} aria-hidden="true" />
        {t("notes.row.untitled")}
        {markers}
      </div>
    );
  }
  if (record.title === null) {
    return (
      <div style={titleUntitledStyle}>
        {t("notes.row.untitled")}
        {markers}
      </div>
    );
  }
  return (
    <div style={titleStyle}>
      {/* `<bdi>` isolates the user-authored title's bidi + auto-directions it,
          so a mixed-script or RTL title reads correctly and does not reorder the
          trailing markers or the surrounding row under RTL. */}
      <bdi>{record.title}</bdi>
      {markers}
    </div>
  );
}

// ─── Inline-rename input (T20) ────────────────────────────────────
//
// Constraints per Q14 of the grill: newline-strip, whitespace-trim,
// empty-rejected (cancel-equivalent), Enter or blur commits, Esc
// cancels. Input auto-focuses on mount and pre-selects all text.

type NoteRowRenameInputProps = {
  initialValue: string;
  onCommit: (trimmedNewTitle: string) => void;
  onCancel: () => void;
};

function NoteRowRenameInput(props: NoteRowRenameInputProps) {
  const { t } = useTranslation();
  const { initialValue, onCommit, onCancel } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const committedRef = useRef(false);
  const [value, setValue] = useState(initialValue);

  // Auto-focus + select-all on mount.
  useLayoutEffect(() => {
    const node = inputRef.current;
    if (node === null) return;
    node.focus();
    node.select();
  }, []);

  const commit = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    // Strip newlines (defensive — input is single-line, but paste may
    // include them). Trim whitespace. Empty → cancel-equivalent.
    const sanitized = value.replace(/[\r\n]+/g, " ").trim();
    if (sanitized.length === 0) {
      onCancel();
      return;
    }
    onCommit(sanitized);
  }, [value, onCommit, onCancel]);

  const cancel = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  }, [onCancel]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    },
    [commit, cancel],
  );

  // Stop click-bubbling so clicks inside the input don't trigger the
  // row's `onSelect` / `onDoubleClick` handlers above.
  const swallow = useCallback((e: ReactMouseEvent<HTMLInputElement>) => {
    e.stopPropagation();
  }, []);

  // Blur → commit (per Q14 cm3 "Enter + blur both commit").
  const handleBlur = useCallback(() => {
    commit();
  }, [commit]);

  // Guard against an outer unmount-before-blur race (e.g., user
  // navigates away with renaming still active). The commit/cancel
  // path is idempotent via `committedRef`.
  //
  // `settledRef` exists because React 19 StrictMode double-invokes
  // effects in dev (mount → cleanup → mount). Without the guard, the
  // cleanup fired `onCancel()` synchronously on that fake unmount,
  // cancelling the rename the instant the input opened — the user could
  // never type (MYND-140). The timer flips `settledRef` on a macrotask
  // that runs strictly AFTER the synchronous StrictMode remount, so only
  // a genuine later unmount (row deleted / scrolled away without a blur
  // commit) reaches `onCancel`.
  const settledRef = useRef(false);
  useEffect(() => {
    const settleTimer = setTimeout(() => {
      settledRef.current = true;
    }, 0);
    return () => {
      clearTimeout(settleTimer);
      if (settledRef.current && !committedRef.current) {
        // Genuine unmount without explicit commit/cancel — treat as
        // cancel so optimistic state doesn't leak.
        committedRef.current = true;
        onCancel();
      }
    };
  }, [onCancel]);

  return (
    <input
      ref={inputRef}
      type="text"
      data-testid="notes.rename-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onClick={swallow}
      onDoubleClick={swallow}
      onContextMenu={(e) => e.stopPropagation()}
      style={renameInputStyle}
      spellCheck={false}
      autoComplete="off"
      aria-label={t("notes.row.renameAriaLabel")}
    />
  );
}
