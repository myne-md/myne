// Global command palette modal — MYND-86.
//
// Keyboard-first discoverable entry point for v1 actions. Per the work
// item acceptance: keyboard shortcut opens it; fuzzy search; typed
// registry; respects state guards; never exposes unavailable actions; no
// plugin / scripting surface.
//
// UI: centered modal over a dim backdrop, input at top, scrollable action
// list with category labels + kbd hints. ArrowUp/Down navigates, Enter
// runs the highlighted action, Esc dismisses. Backdrop click dismisses.
//
// Special action `note.switch` toggles the palette into a note-picker
// view: input filters by note title, Enter selects the highlighted note.
// Backspace at empty query returns to the main action list.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { COMMAND_ACTIONS, fuzzyFilter } from "../commands";
import type {
  ActionVisibility,
  CommandAction,
  CommandContext,
} from "../commands";
import type { NoteId } from "../notes/sidebarState";

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.32)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  paddingTop: "12vh",
  zIndex: 1500,
};

const MODAL_STYLE: CSSProperties = {
  width: 520,
  maxHeight: "60vh",
  background: "var(--paper, #faf8f3)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-3, 8px)",
  boxShadow: "var(--shadow-3, 0 16px 48px rgba(0,0,0,0.18))",
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-sans)",
  overflow: "hidden",
};

const INPUT_STYLE: CSSProperties = {
  width: "100%",
  // Reset WebKit's default text-input focus underline (which renders as
  // a thick accent-blue line below the field). `outline: none` alone is
  // not enough on macOS WebKit; `appearance: none` removes the platform
  // styling layer too.
  appearance: "none",
  WebkitAppearance: "none",
  border: 0,
  borderBottom: "1px solid var(--line-1, #e3e2dd)",
  background: "transparent",
  outline: "none",
  boxShadow: "none",
  fontFamily: "var(--font-sans)",
  fontSize: 15,
  color: "var(--fg-1)",
  padding: "14px 16px",
};

const LIST_STYLE: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 6,
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  borderRadius: "var(--radius-1, 3px)",
  cursor: "pointer",
  fontSize: 13,
  color: "var(--fg-1)",
};

const ROW_SELECTED_STYLE: CSSProperties = {
  ...ROW_STYLE,
  background: "var(--paper-2)",
};

const ROW_DISABLED_STYLE: CSSProperties = {
  ...ROW_STYLE,
  color: "var(--fg-3)",
  cursor: "not-allowed",
};

const CATEGORY_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-3)",
  fontWeight: 500,
  marginRight: "auto",
};

const HINT_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-3)",
  fontFamily: "var(--font-mono)",
};

const EMPTY_STYLE: CSSProperties = {
  padding: "20px 16px",
  fontSize: 13,
  color: "var(--fg-3)",
  textAlign: "center",
};

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  ctx: CommandContext;
};

type Mode =
  | { kind: "actions" }
  | { kind: "note-picker" };

type Row =
  | { kind: "action"; action: CommandAction; visibility: ActionVisibility }
  | { kind: "note"; id: NoteId; title: string };

export function CommandPalette({ open, onClose, ctx }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>({ kind: "actions" });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset state every time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setMode({ kind: "actions" });
      setSelectedIndex(0);
      // Focus input on next tick (after mount + portal append).
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Build the row list per mode + apply fuzzy filter.
  const rows: Row[] = useMemo(() => {
    if (mode.kind === "note-picker") {
      const candidates = Array.from(ctx.noteTitles.entries()).map(
        ([id, title]) => ({
          item: { id, title: title ?? "" },
          haystacks: [title ?? "Untitled"],
        }),
      );
      const matches = fuzzyFilter(candidates, query);
      return matches.map(
        (m): Row => ({
          kind: "note",
          id: m.item.id,
          title: m.item.title === "" ? "Untitled" : m.item.title,
        }),
      );
    }
    const visibleActions: Array<{
      action: CommandAction;
      visibility: ActionVisibility;
    }> = [];
    for (const action of COMMAND_ACTIONS) {
      const v = action.visibility(ctx);
      if (v === "hidden") continue;
      visibleActions.push({ action, visibility: v });
    }
    const candidates = visibleActions.map((e) => ({
      item: e,
      haystacks: [e.action.label, e.action.id, e.action.category ?? ""],
    }));
    const matches = fuzzyFilter(candidates, query);
    return matches.map(
      (m): Row => ({
        kind: "action",
        action: m.item.action,
        visibility: m.item.visibility,
      }),
    );
  }, [mode.kind, query, ctx]);

  // Clamp selected index when row count changes.
  useEffect(() => {
    if (selectedIndex >= rows.length) {
      setSelectedIndex(Math.max(0, rows.length - 1));
    }
  }, [rows.length, selectedIndex]);

  const close = useCallback(() => {
    setQuery("");
    setMode({ kind: "actions" });
    setSelectedIndex(0);
    onClose();
  }, [onClose]);

  const runRow = useCallback(
    async (row: Row) => {
      if (row.kind === "action") {
        if (row.visibility === "disabled") return;
        if (row.action.id === "note.switch") {
          setMode({ kind: "note-picker" });
          setQuery("");
          setSelectedIndex(0);
          requestAnimationFrame(() => inputRef.current?.focus());
          return;
        }
        close();
        try {
          await row.action.run(ctx);
        } catch {
          /* action failure surfaces via the action's own UX (toast / banner) */
        }
      } else {
        close();
        try {
          await ctx.onSelectNote(row.id);
        } catch {
          /* selection failure surfaces via sidebar UX */
        }
      }
    },
    [ctx, close],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) =>
          rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length,
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const row = rows[selectedIndex];
        if (row !== undefined) void runRow(row);
        return;
      }
      if (
        e.key === "Backspace" &&
        mode.kind === "note-picker" &&
        query === ""
      ) {
        e.preventDefault();
        setMode({ kind: "actions" });
        setSelectedIndex(0);
        return;
      }
    },
    [rows, selectedIndex, runRow, mode.kind, query, close],
  );

  const onBackdropClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) close();
    },
    [close],
  );

  if (!open) return null;

  const placeholder =
    mode.kind === "note-picker"
      ? "Search notes by title…"
      : "Type a command — Esc to dismiss";

  return (
    <div
      style={BACKDROP_STYLE}
      onClick={onBackdropClick}
      role="presentation"
    >
      <div
        style={MODAL_STYLE}
        role="dialog"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          style={INPUT_STYLE}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <div style={LIST_STYLE} role="listbox">
          {rows.length === 0 ? (
            <div style={EMPTY_STYLE}>
              {mode.kind === "note-picker"
                ? "No notes match"
                : "No commands match"}
            </div>
          ) : (
            rows.map((row, i) => renderRow(row, i, i === selectedIndex, runRow))
          )}
        </div>
      </div>
    </div>
  );
}

function renderRow(
  row: Row,
  index: number,
  selected: boolean,
  runRow: (row: Row) => void | Promise<void>,
) {
  const isDisabled = row.kind === "action" && row.visibility === "disabled";
  const style = isDisabled
    ? ROW_DISABLED_STYLE
    : selected
      ? ROW_SELECTED_STYLE
      : ROW_STYLE;
  const key = row.kind === "action" ? row.action.id : `note:${row.id}`;
  return (
    <div
      key={key}
      style={style}
      role="option"
      aria-selected={selected}
      aria-disabled={isDisabled}
      data-row-index={index}
      onMouseDown={(e) => {
        e.preventDefault();
        if (!isDisabled) void runRow(row);
      }}
    >
      {row.kind === "action" ? (
        <>
          <span style={{ flex: 1 }}>{row.action.label}</span>
          {row.action.category !== undefined && (
            <span style={CATEGORY_STYLE}>{row.action.category}</span>
          )}
          {isDisabled && row.action.disabledHint !== undefined && (
            <span style={HINT_STYLE}>{row.action.disabledHint}</span>
          )}
          {!isDisabled && row.action.kbd !== undefined && (
            <span style={HINT_STYLE}>{row.action.kbd}</span>
          )}
        </>
      ) : (
        <span style={{ flex: 1 }}>{row.title}</span>
      )}
    </div>
  );
}
