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
import type { TitleRecord } from "../loadNoteBatch";
import { uuidv7Ms } from "../sidebarState";
import { ColorDot } from "./ColorDot";
import { formatRelativeTime, useTick } from "./relativeTime";

export type NoteRowProps = {
  record: TitleRecord;
  selected: boolean;
  renaming: boolean;
  /** Click handler → caller dispatches selection + open. `opts.newTab`
   *  is set on Cmd/Ctrl-click or middle-click (open in a new tab);
   *  `opts.toSide` on Alt-click (split to the side) — MYND-166. */
  onSelect: (id: string, opts?: { newTab?: boolean; toSide?: boolean }) => void;
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
  /** Color-label slot (MYND-184) — renders a small leading dot before the
   *  title. Undefined when the note has no color. */
  colorSlot?: string;
  /** Whether to render the relative-time subtitle line (sidebar-note-timestamps).
   *  Defaults to `true` (the pre-feature behaviour). When `false` the subtitle
   *  `<div>` is omitted entirely and the title vertically centers in the row's
   *  fixed `minHeight`. Driven by `PrefsView.show_note_timestamps`. */
  showTimestamps?: boolean;
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
  gap: 8,
  padding: "8px 14px",
  minHeight: 52,
  cursor: "pointer",
  borderRadius: 3,
  marginLeft: 4,
  marginRight: 4,
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
  fontSize: 13,
  fontWeight: 500,
  color: "var(--fg-1)",
  lineHeight: 1.35,
};

const titleUntitledStyle: CSSProperties = {
  ...titleStyle,
  fontStyle: "italic",
  color: "var(--fg-3)",
  fontWeight: 400,
};

const subtitleStyle: CSSProperties = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  fontWeight: 400,
  color: "var(--fg-3)",
  lineHeight: 1.3,
};

const errorIndicatorStyle: CSSProperties = {
  display: "inline-block",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--warning)",
  marginRight: 6,
  verticalAlign: "middle",
};

const renameInputStyle: CSSProperties = {
  display: "block",
  width: "100%",
  border: "1px solid var(--accent)",
  borderRadius: 3,
  padding: "1px 4px",
  margin: "-2px -5px",
  background: "var(--paper)",
  color: "var(--fg-1)",
  font: "inherit",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.35,
  outline: "none",
};

// ─── Component ────────────────────────────────────────────────────

export function NoteRow(props: NoteRowProps) {
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

  const handleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // Alt-click → split to the side; Cmd/Ctrl-click → new tab; plain
      // click → reuse the focused tab.
      onSelect(record.noteUuid, {
        newTab: e.metaKey || e.ctrlKey,
        toSide: e.altKey,
      });
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
      onContextMenu(record.noteUuid, { x: e.clientX, y: e.clientY });
    },
    [onContextMenu, record.noteUuid],
  );

  const composedRowStyle: CSSProperties = {
    ...rowBaseStyle,
    ...(showTimestamps ? {} : rowCompactStyle),
    ...(selected ? rowSelectedStyle : hovering ? rowHoverStyle : {}),
  };

  return (
    <div
      style={composedRowStyle}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      data-testid="notes.row"
      data-note-id={record.noteUuid}
      role="button"
      aria-selected={selected}
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
          <TitleLine record={record} colorSlot={colorSlot} />
        )}
        {showTimestamps && (
          <div style={subtitleStyle} data-testid="notes.row-subtitle">
            {subtitleText}
          </div>
        )}
      </div>
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
            aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
            title={favorited ? "Remove from favorites" : "Add to favorites"}
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

function TitleLine({
  record,
  colorSlot,
}: {
  record: TitleRecord;
  colorSlot?: string;
}) {
  const dot = <ColorDot slot={colorSlot} style={{ marginRight: 6, verticalAlign: "middle" }} />;
  if (record.error !== undefined) {
    return (
      <div style={titleUntitledStyle} title="Couldn't load this note">
        {dot}
        <span style={errorIndicatorStyle} aria-hidden="true" />
        Untitled
      </div>
    );
  }
  if (record.title === null) {
    return (
      <div style={titleUntitledStyle}>
        {dot}
        Untitled
      </div>
    );
  }
  return (
    <div style={titleStyle}>
      {dot}
      {record.title}
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
      aria-label="Rename note"
    />
  );
}
