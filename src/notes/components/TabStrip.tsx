// `<TabStrip>` — per-pane editor tab strip (MYND-166, Task 3).
//
// Visual canon: Penpot frame `screen------editor-tabs--strip-states
// (MYND-166 · A)` on page `4 — Desktop UI Kit`. Tokens per
// `colors_and_type.css`:
//  - strip surface = --paper-2, bottom hairline = --line-1, height 38
//    (matches the editor's prior title-row height so the layout is stable).
//  - active tab = --bg-1 (paper) fill + 2px --accent top indicator + NO
//    bottom hairline (reads "flush into the editor below"); ink --fg-1.
//  - inactive tab = --fg-2 ink on the strip surface; hover = --paper-3.
//  - leading file-text icon, or a dirty dot when the tab has unsaved
//    edits; trailing × close (on hover / active); a `+` new-tab control
//    and a `…` overflow menu listing all open tabs.
//
// Overflow is handled two ways at once: the tab row scrolls horizontally
// (`overflow-x: auto`) AND the `…` menu lists every open tab for direct
// switching when the strip is too narrow to show them all.

import {
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Icon } from "../../components/primitives/Icon";
import type { IconName } from "../../lib/icons";
import { TAB_DRAG_MIME, readTabDrag, writeTabDrag } from "../tabDrag";

/** Strip height (px) — also the editor body's top inset, so the drop overlay
 *  starts below the strip and leaves the tabs interactive during a drag. */
export const STRIP_HEIGHT = 38;

/** Base strip layout. Per-pane: each pane owns its own strip atop its editor
 *  body. A `--line-1` bottom hairline runs the FULL strip width — the editor's
 *  top edge — continuously (the active tab sits on it, Obsidian-style; the
 *  line does NOT break under it). A small top inset gives the tabs breathing
 *  room. Fixed height; fills the pane width. `paddingLeft`/`paddingRight` are
 *  overridden per-instance to clear the corner window controls (insets). */
const STRIP_BASE_PADDING_LEFT = 6;
const stripStyle: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  flexShrink: 0,
  gap: 2,
  paddingLeft: STRIP_BASE_PADDING_LEFT,
  paddingTop: 5,
  height: STRIP_HEIGHT,
  background: "var(--paper-2)",
  borderBottom: "1px solid var(--line-1)",
  position: "relative",
};

const scrollAreaStyle: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: 2,
  // Content-sized: doesn't grow (the draggable filler eats the slack), but
  // shrinks + scrolls once the tabs can't fit even after ellipsizing.
  flex: "0 1 auto",
  minWidth: 0,
  overflowX: "auto",
  overflowY: "hidden",
};

/** Height of the small strip buttons (+ / overflow), centered in the strip. */
const STRIP_BUTTON_HEIGHT = 28;

const TITLE_MAX = 160;

export type TabStripProps = {
  /** The pane this strip belongs to (carried in drag payloads). */
  paneId: string;
  /** Opaque per-tab handles (workspace `itemKey`s, MYND-274) — a note or a
   *  view tab; this component treats them as strings and never parses them. */
  tabs: readonly string[];
  activeTab: string | null;
  /** Display title for a tab handle; `null` → rendered as italic "Untitled". */
  titleOf: (id: string) => string | null;
  /** Leading icon for a tab handle (note vs view, MYND-274). Default file-text. */
  iconOf?: (id: string) => IconName;
  /** Whether the ACTIVE tab currently has unsaved edits (drives its dot). */
  activeDirty?: boolean;
  /** A transient empty "New tab" is open (the chooser). Renders an active
   *  pseudo-tab after the real tabs; the real tabs render inactive. */
  pendingNewTab?: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
  /** Close the transient "New tab" (return to the previously-active tab). */
  onCloseNewTab?: () => void;
  /** Drop handler — `fromPaneId` is the drag source (`null` when the drag
   *  came from the sidebar), `toIndex` the insert slot in THIS strip.
   *  Reorder (same pane), move (cross pane), or open (sidebar-origin). */
  onMoveTab: (fromPaneId: string | null, tabId: string, toIndex: number) => void;
  /** Extra left padding (px) when this strip sits at the window's top-left
   *  corner with no left sidebar — clears the traffic lights + left toggle. */
  insetLeft?: number;
  /** Extra right padding (px) when this strip sits at the window's top-right
   *  corner with no right sidebar — clears the right sidebar toggle. */
  insetRight?: number;
};

export function TabStrip({
  paneId,
  tabs,
  activeTab,
  titleOf,
  iconOf,
  activeDirty = false,
  pendingNewTab = false,
  onActivate,
  onClose,
  onNewTab,
  onCloseNewTab,
  onMoveTab,
  insetLeft = 0,
  insetRight = 0,
}: TabStripProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  const handleDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const parsed = readTabDrag(e.dataTransfer);
    if (parsed === null) return;
    const tabEls = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"][data-tab-id]'),
    );
    let toIndex = tabEls.length;
    for (let i = 0; i < tabEls.length; i++) {
      const r = tabEls[i]!.getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        toIndex = i;
        break;
      }
    }
    // Same-pane rightward move: the source is removed before re-insert, so
    // shift the target left by one to land where the cursor points.
    if (parsed.fromPaneId === paneId) {
      const orig = tabEls.findIndex(
        (el) => el.getAttribute("data-tab-id") === parsed.tabId,
      );
      if (orig >= 0 && orig < toIndex) toIndex -= 1;
    }
    onMoveTab(parsed.fromPaneId, parsed.tabId, toIndex);
  };

  return (
    <div
      style={{
        ...stripStyle,
        paddingLeft: STRIP_BASE_PADDING_LEFT + insetLeft,
        paddingRight: insetRight,
      }}
      role="tablist"
      aria-label="Open notes"
      data-testid="editor.tab-strip"
      data-pane-id={paneId}
      // Whole strip is a drop target (reorder / move / open) — dropping in the
      // empty trailing space appends, dropping among the tabs inserts.
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TAB_DRAG_MIME)) e.preventDefault();
      }}
      onDrop={handleDrop}
    >
      <div style={scrollAreaStyle}>
        {tabs.map((id) => (
          <Tab
            key={id}
            id={id}
            paneId={paneId}
            title={titleOf(id)}
            icon={iconOf?.(id) ?? "file-text"}
            active={id === activeTab}
            dirty={id === activeTab && activeDirty}
            onActivate={onActivate}
            onClose={onClose}
          />
        ))}
        {pendingNewTab && <NewTabChip onClose={onCloseNewTab} />}
        <StripButton label="New tab" onClick={onNewTab}>
          <Icon name="plus" size={14} />
        </StripButton>
      </div>

      {/* The empty trailing expanse doubles as the window-drag handle (the
          strip sits on the OS title-bar row for a top pane), Obsidian-style. */}
      <div data-tauri-drag-region style={{ flex: "1 1 auto", minWidth: 16 }} />

      {tabs.length > 0 && (
        <StripButton
          label="Open notes"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
        >
          <Icon name="more-horizontal" size={14} />
        </StripButton>
      )}

      {menuOpen && tabs.length > 0 && (
        <OverflowMenu
          tabs={tabs}
          activeTab={activeTab}
          titleOf={titleOf}
          onPick={(id) => {
            setMenuOpen(false);
            onActivate(id);
          }}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}

function tabLabel(title: string | null): { text: string; italic: boolean } {
  if (title === null || title.trim() === "") {
    return { text: "Untitled", italic: true };
  }
  return { text: title, italic: false };
}

type TabProps = {
  id: string;
  paneId: string;
  title: string | null;
  icon: IconName;
  active: boolean;
  dirty: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
};

function Tab({ id, paneId, title, icon, active, dirty, onActivate, onClose }: TabProps) {
  const [hovering, setHovering] = useState(false);
  const { text, italic } = tabLabel(title);
  const showClose = hovering || active;

  const handleDragStart = (e: ReactDragEvent<HTMLDivElement>) => {
    writeTabDrag(e.dataTransfer, { tabId: id, fromPaneId: paneId });
    e.dataTransfer.effectAllowed = "move";
  };

  // Obsidian-style tabs: the active tab is a rounded-top card with a top/side
  // hairline, sitting ON the strip's full-width bottom line (which runs left→
  // right continuously, NOT broken under the tab). It has NO bottom border, so
  // it reads as open toward the body beneath the line. Inactive tabs recede —
  // transparent, dimmed `--fg-3`, lower opacity, no border. Tabs shrink
  // (ellipsizing their title) as the pane narrows, then the row scrolls once
  // they hit their content floor.
  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: "100%",
    padding: "0 6px 0 10px",
    maxWidth: TITLE_MAX + 56,
    minWidth: 0,
    flexShrink: 1,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    borderTop: active ? "1px solid var(--line-1)" : "1px solid transparent",
    borderLeft: active ? "1px solid var(--line-1)" : "1px solid transparent",
    borderRight: active ? "1px solid var(--line-1)" : "1px solid transparent",
    background: active
      ? "var(--bg-1)"
      : hovering
        ? "var(--paper-3)"
        : "transparent",
    color: active ? "var(--fg-1)" : "var(--fg-3)",
    opacity: active || hovering ? 1 : 0.72,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    fontSize: 13,
  };

  // Middle-click closes the tab (browser-tab idiom).
  const handleAux = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button === 1) {
      e.preventDefault();
      onClose(id);
    }
  };

  return (
    <div
      role="tab"
      aria-selected={active}
      data-testid="editor.tab"
      data-tab-id={id}
      data-active={active}
      title={text}
      draggable
      onDragStart={handleDragStart}
      style={style}
      onClick={() => onActivate(id)}
      onAuxClick={handleAux}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <span
        aria-hidden="true"
        style={{
          display: "flex",
          width: 14,
          flexShrink: 0,
          justifyContent: "center",
          color: dirty ? "var(--accent)" : "var(--fg-3)",
        }}
      >
        {dirty ? (
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "var(--radius-pill)",
              background: "var(--accent)",
            }}
          />
        ) : (
          <Icon name={icon} size={13} />
        )}
      </span>
      <span
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          maxWidth: TITLE_MAX,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontStyle: italic ? "italic" : "normal",
          color: italic ? "var(--fg-3)" : undefined,
        }}
      >
        {text}
      </span>
      <button
        type="button"
        aria-label={`Close ${text}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose(id);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 18,
          height: 18,
          flexShrink: 0,
          padding: 0,
          border: 0,
          borderRadius: "var(--radius-1)",
          background: "transparent",
          color: "var(--fg-3)",
          cursor: "pointer",
          visibility: showClose ? "visible" : "hidden",
        }}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

/** The transient empty "New tab" pseudo-tab (active while its chooser is
 *  open). Carries the same active-tab look as a real tab. */
function NewTabChip({ onClose }: { onClose?: () => void }) {
  return (
    <div
      role="tab"
      aria-selected
      title="New tab"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: "100%",
        padding: "0 6px 0 10px",
        borderTopLeftRadius: 8,
        borderTopRightRadius: 8,
        borderTop: "1px solid var(--line-1)",
        borderLeft: "1px solid var(--line-1)",
        borderRight: "1px solid var(--line-1)",
        background: "var(--bg-1)",
        color: "var(--fg-2)",
        flexShrink: 0,
        fontFamily: "var(--font-sans)",
        fontSize: 13,
      }}
    >
      <Icon name="file-text" size={13} />
      <span style={{ fontStyle: "italic", color: "var(--fg-3)" }}>New tab</span>
      {onClose && (
        <button
          type="button"
          aria-label="Close new tab"
          onClick={onClose}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            padding: 0,
            border: 0,
            borderRadius: "var(--radius-1)",
            background: "transparent",
            color: "var(--fg-3)",
            cursor: "pointer",
          }}
        >
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

function StripButton({
  label,
  onClick,
  children,
  ...rest
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        alignSelf: "center",
        width: 28,
        height: STRIP_BUTTON_HEIGHT,
        flexShrink: 0,
        border: 0,
        borderRadius: 8,
        background: "transparent",
        color: "var(--fg-3)",
        cursor: "pointer",
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

function OverflowMenu({
  tabs,
  activeTab,
  titleOf,
  onPick,
  onClose,
}: {
  tabs: readonly string[];
  activeTab: string | null;
  titleOf: (id: string) => string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      {/* click-away backdrop */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 10 }}
        aria-hidden="true"
      />
      <ul
        role="menu"
        style={{
          position: "absolute",
          top: STRIP_HEIGHT,
          right: 0,
          zIndex: 11,
          margin: 0,
          padding: 4,
          listStyle: "none",
          minWidth: 200,
          maxHeight: 320,
          overflowY: "auto",
          background: "var(--bg-1)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-2)",
          boxShadow: "var(--shadow-2, 0 6px 20px rgba(0,0,0,0.12))",
        }}
      >
        {tabs.map((id) => {
          const { text, italic } = tabLabel(titleOf(id));
          return (
            <li key={id} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => onPick(id)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 8px",
                  border: 0,
                  borderRadius: "var(--radius-1)",
                  background:
                    id === activeTab ? "var(--accent-soft)" : "transparent",
                  color: italic ? "var(--fg-3)" : "var(--fg-1)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                  fontStyle: italic ? "italic" : "normal",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {text}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
