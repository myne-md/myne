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

import { dragRegionProps } from "../../screens/titlebar";
import {
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { labelColorVar } from "../decorations";
import { Icon } from "../../components/primitives/Icon";
import {
  hoverSurface,
  HOVER_TRANSITION,
} from "../../components/primitives/hoverSurface";
import type { IconName } from "../../lib/icons";
import { TAB_DRAG_MIME, readTabDrag, writeTabDrag } from "../tabDrag";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ornamentRole } from "@myne/ornaments";

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
  paddingInlineStart: STRIP_BASE_PADDING_LEFT,
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
  /** Colour-label slot for a tab, or `undefined` for an uncoloured item
   *  (MYND-627). Tints the tab's icon, matching how the sidebar shows the same
   *  colour — a note you marked stays recognisable once it is open, which was
   *  the point of colouring it. */
  colorOf?: (id: string) => string | undefined;
  /** Leading icon for a tab handle (note vs view, MYND-274). Default file-text. */
  iconOf?: (id: string) => IconName;
  /** Whether a tab handle is PINNED (tab-modes / MYND-320): a pinned tab shows a
   *  pin affordance, hides its × close, and offers Unpin in its right-click
   *  menu. Absent ⇒ no tab pinned. */
  isPinned?: (id: string) => boolean;
  /** Toggle a tab's pinned state — wired from the tab right-click menu
   *  (tab-modes / MYND-320). Absent ⇒ the Pin/Unpin item is not offered. */
  onTogglePin?: (id: string) => void;
  /** Render the tabs as a STACKED deck (horizontally-scrolling, partially-
   *  overlapping) instead of the normal strip (tab-modes / MYND-319). */
  stacked?: boolean;
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
  colorOf,
  iconOf,
  isPinned,
  onTogglePin,
  stacked = false,
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
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  // Right-click tab context menu (tab-modes / MYND-320): { tab key, click pos }.
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );

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
      // The tab strip is CHROME for ornament purposes (myne#394). Ornament here
      // is paint only, so a themed strip's tab hit areas are exactly where an
      // unthemed one's were — the property task 14 measures.
      {...ornamentRole("chrome")}
      style={{
        ...stripStyle,
        paddingInlineStart: STRIP_BASE_PADDING_LEFT + insetLeft,
        paddingInlineEnd: insetRight,
        // The insets clear the floated window controls (traffic lights /
        // sidebar toggles / back-forward nav) when a side has no sidebar, so
        // they flip with the sidebar's collapsed state. Transition them on the
        // SAME curve as the sidebar's width collapse (SidebarPane) so the tab
        // strip glides in sync instead of snapping the first tab across the
        // floated controls for a frame. Reduced-motion zeroes this globally.
        transition:
          "padding-left var(--duration-base) var(--ease-standard), padding-right var(--duration-base) var(--ease-standard)",
      }}
      role="tablist"
      aria-label={t("notes.tabStrip.openNotes")}
      data-editor-chrome
      data-testid="editor.tab-strip"
      data-pane-id={paneId}
      data-stacked={stacked}
      // Whole strip is a drop target (reorder / move / open) — dropping in the
      // empty trailing space appends, dropping among the tabs inserts.
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TAB_DRAG_MIME)) e.preventDefault();
      }}
      onDrop={handleDrop}
    >
      <div
        // Transparent to the a11y tree so the `role="tab"` children below are
        // owned directly by the `role="tablist"` parent — without this the
        // generic wrapper breaks axe's `aria-required-children` (MYND-93).
        role="presentation"
        style={
          stacked
            ? // Stacked deck (tab-modes / MYND-319): tabs overlap (negative
              // gap) and the row scrolls horizontally. Functional layout —
              // visual polish deferred to a later slice.
              { ...scrollAreaStyle, gap: 0, paddingInlineStart: 14 }
            : scrollAreaStyle
        }
        data-testid={stacked ? "editor.tab-deck" : undefined}
      >
        {tabs.map((id, i) => (
          <Tab
            key={id}
            id={id}
            paneId={paneId}
            title={titleOf(id)}
            colorSlot={colorOf?.(id)}
            icon={iconOf?.(id) ?? "file-text"}
            active={id === activeTab}
            dirty={id === activeTab && activeDirty}
            pinned={isPinned?.(id) ?? false}
            stacked={stacked}
            stackIndex={i}
            onActivate={onActivate}
            onClose={onClose}
            onContextMenu={
              onTogglePin
                ? (x, y) => setTabMenu({ id, x, y })
                : undefined
            }
          />
        ))}
        {pendingNewTab && <NewTabChip onClose={onCloseNewTab} />}
        <StripButton label={t("notes.tabStrip.newTab")} onClick={onNewTab}>
          <Icon name="plus" size={14} />
        </StripButton>
      </div>

      {/* The empty trailing expanse doubles as the window-drag handle (the
          strip sits on the OS title-bar row for a top pane), Obsidian-style. */}
      <div {...dragRegionProps()} style={{ flex: "1 1 auto", minWidth: 16 }} />

      {tabs.length > 0 && (
        <StripButton
          label={t("notes.tabStrip.openNotes")}
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
        >
          {/* Caret that flips 180° when the tab list is open (animated). */}
          <span
            style={{
              display: "flex",
              transform: menuOpen ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform var(--duration-base) var(--ease-standard)",
            }}
          >
            <Icon name="chevron-down" size={14} />
          </span>
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

      {/* Tab right-click context menu (tab-modes / MYND-320): Pin / Unpin
          (reuses the shared ContextMenu, like the sidebar + card menus). */}
      {tabMenu !== null && onTogglePin && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenuItems(tabMenu.id, isPinned?.(tabMenu.id) ?? false, onTogglePin)}
          onClose={() => setTabMenu(null)}
        />
      )}
    </div>
  );
}

/** The tab right-click menu's items (tab-modes / MYND-320): a single
 *  Pin/Unpin toggle item whose label reflects the current state. */
function tabMenuItems(
  id: string,
  pinned: boolean,
  onTogglePin: (id: string) => void,
): ContextMenuItem[] {
  return [
    {
      id: pinned ? "tab.unpin" : "tab.pin",
      label: pinned ? i18n.t("notes.tabStrip.unpin") : i18n.t("notes.tabStrip.pin"),
      onSelect: () => onTogglePin(id),
    },
  ];
}

function tabLabel(title: string | null): { text: string; italic: boolean } {
  if (title === null || title.trim() === "") {
    return { text: i18n.t("notes.tabStrip.untitled"), italic: true };
  }
  return { text: title, italic: false };
}

type TabProps = {
  id: string;
  paneId: string;
  title: string | null;
  icon: IconName;
  /** Colour-label slot; tints the icon (MYND-627). */
  colorSlot?: string;
  active: boolean;
  dirty: boolean;
  /** Pinned (tab-modes / MYND-320): pin affordance shown, × close-guarded. */
  pinned: boolean;
  /** Whether the pane is in stacked-deck layout (tab-modes / MYND-319). */
  stacked: boolean;
  /** Position in the strip — drives the stacked overlap offset. */
  stackIndex: number;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** Right-click (tab-modes / MYND-320): open the Pin/Unpin menu at the cursor. */
  onContextMenu?: (x: number, y: number) => void;
};

function Tab({
  id,
  paneId,
  title,
  icon,
  colorSlot,
  active,
  dirty,
  pinned,
  stacked,
  stackIndex,
  onActivate,
  onClose,
  onContextMenu,
}: TabProps) {
  const { t } = useTranslation();
  const [hovering, setHovering] = useState(false);
  const { text, italic } = tabLabel(title);
  // A pinned tab is close-protected — its × is hidden (unpin to close).
  const showClose = !pinned && (hovering || active);

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
    flexShrink: stacked ? 0 : 1,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    // In a stacked deck every card carries a full hairline (the cards overlap,
    // so a transparent border would let the underlying card bleed through);
    // in the normal strip only the active tab is bordered.
    borderTop:
      active || stacked ? "1px solid var(--line-1)" : "1px solid transparent",
    borderInlineStart:
      active || stacked ? "1px solid var(--line-1)" : "1px solid transparent",
    borderInlineEnd:
      active || stacked ? "1px solid var(--line-1)" : "1px solid transparent",
    background: active
      ? "var(--bg-1)"
      : stacked
        ? "var(--bg-2)"
        : hovering
          ? "var(--paper-3)"
          : "transparent",
    color: active ? "var(--fg-1)" : stacked ? "var(--fg-2)" : "var(--fg-3)",
    // Stacked cards OVERLAP, so a sub-1 opacity would let the card beneath bleed
    // through (the muddy look). Keep stacked cards fully opaque and convey depth
    // with z-order + a left-edge shadow instead.
    opacity: stacked || active || hovering ? 1 : 0.72,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    // Stacked deck (tab-modes / MYND-319): cards partially overlap and each casts
    // a soft shadow onto the card behind it, so the row reads as a front-to-back
    // deck; the active/hovered card lifts above the rest. Functional layout.
    ...(stacked
      ? {
          marginInlineStart: stackIndex === 0 ? 0 : -16,
          zIndex: active ? 200 : hovering ? 100 : stackIndex + 1,
          position: "relative",
          boxShadow:
            stackIndex === 0
              ? "none"
              : active
                ? "-5px 0 9px rgba(0, 0, 0, 0.24)"
                : "-3px 0 6px rgba(0, 0, 0, 0.13)",
        }
      : {}),
  };

  // Middle-click closes the tab (browser-tab idiom) — but a pinned tab is
  // close-protected (unpin first), so middle-click is inert on it.
  const handleAux = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button === 1) {
      e.preventDefault();
      if (!pinned) onClose(id);
    }
  };

  return (
    <div
      role="tab"
      aria-selected={active}
      data-testid="editor.tab"
      data-tab-id={id}
      data-active={active}
      data-pinned={pinned}
      title={text}
      draggable
      onDragStart={handleDragStart}
      style={style}
      onClick={() => onActivate(id)}
      onAuxClick={handleAux}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(e.clientX, e.clientY);
            }
          : undefined
      }
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
          <Icon
            name={icon}
            size={13}
            style={colorSlot ? { color: labelColorVar(colorSlot) } : undefined}
          />
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
        {/* Isolate the user-authored tab title's direction (RTL/bidi). */}
        <bdi>{text}</bdi>
      </span>
      {pinned ? (
        // Pinned: a static pin glyph stands in for the × — the tab is
        // close-protected (unpin via the right-click menu to close it).
        <span
          aria-label={t("notes.tabStrip.pinned")}
          title={t("notes.tabStrip.pinnedTitle")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            flexShrink: 0,
            color: "var(--fg-3)",
          }}
        >
          <Icon name="pin" size={12} />
        </span>
      ) : (
        <button
          type="button"
          aria-label={t("notes.tabStrip.closeTab", { title: text })}
          onClick={(e) => {
            e.stopPropagation();
            onClose(id);
          }}
          {...hoverSurface()}
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
            transition: HOVER_TRANSITION,
          }}
        >
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

/** The transient empty "New tab" pseudo-tab (active while its chooser is
 *  open). Carries the same active-tab look as a real tab. */
function NewTabChip({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="tab"
      aria-selected
      title={t("notes.tabStrip.newTab")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: "100%",
        padding: "0 6px 0 10px",
        borderTopLeftRadius: 8,
        borderTopRightRadius: 8,
        borderTop: "1px solid var(--line-1)",
        borderInlineStart: "1px solid var(--line-1)",
        borderInlineEnd: "1px solid var(--line-1)",
        background: "var(--bg-1)",
        color: "var(--fg-2)",
        flexShrink: 0,
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
      }}
    >
      <Icon name="file-text" size={13} />
      <span style={{ fontStyle: "italic", color: "var(--fg-3)" }}>
        {t("notes.tabStrip.newTab")}
      </span>
      {onClose && (
        <button
          type="button"
          aria-label={t("notes.tabStrip.closeNewTab")}
          onClick={onClose}
          {...hoverSurface()}
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
            transition: HOVER_TRANSITION,
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
      {...hoverSurface()}
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
        transition: HOVER_TRANSITION,
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
          insetInlineEnd: 0,
          zIndex: 11,
          margin: 0,
          padding: "var(--space-1)",
          listStyle: "none",
          minWidth: 200,
          // Cap the width so a long tab title (e.g. a clipped web page's full
          // headline) can't stretch the menu across the window. The items
          // already ellipsis-truncate — but only once their box is bounded, so
          // this maxWidth is what actually makes the truncation take effect.
          maxWidth: 320,
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
                title={text}
                onClick={() => onPick(id)}
                {...hoverSurface({
                  restBg:
                    id === activeTab ? "var(--accent-soft)" : "transparent",
                  hoverBg:
                    id === activeTab ? "var(--accent-soft)" : "var(--bg-3)",
                })}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "start",
                  padding: "6px 8px",
                  border: 0,
                  borderRadius: "var(--radius-1)",
                  background:
                    id === activeTab ? "var(--accent-soft)" : "transparent",
                  color: italic ? "var(--fg-3)" : "var(--fg-1)",
                  fontFamily: "var(--font-sans)",
                  fontSize: "var(--text-sm)",
                  fontStyle: italic ? "italic" : "normal",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  transition: HOVER_TRANSITION,
                }}
              >
                <bdi>{text}</bdi>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
