// `<ViewsSection>` — the sidebar "Views" entry (Saved Views #4, MYND-274).
//
// A compact nav ROW styled like the Attachments / Trash / Archive footer
// entries (icon + "Views"), with two hover-revealed controls at its right edge:
// a create (+) button and a right-caret. Clicking the row (or the caret) opens a
// FLYOUT to the right — a scrollable, searchable panel listing every saved view
// — instead of cramming the whole list into the left sidebar. A view opens as a
// workspace tab on click (`ws.openView`); right-click a row for rename / delete /
// move / settings; inline-rename lives in the flyout too.
//
// Design canon: Penpot frame `screen------views--sidebar-section (MYND-274)`.
// Leading glyph `layout-grid` (saved views render as table/cards/grid).

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components/primitives/Icon";
import {
  hoverSurface,
  HOVER_TRANSITION,
} from "../../components/primitives/hoverSurface";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import type { SavedView } from "../../lib/prefs";
import {
  consumeRevealViews,
  useRevealViewsNonce,
} from "../views/revealViewsSignal";

// Nav row — mirrors NoteList's FOOTER_ENTRY_STYLE so Views reads as a peer of
// Attachments / Trash / Archive. Keep the two in step.
const NAV_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  padding: "var(--space-3) var(--space-4)",
  border: "none",
  borderTop: "1px solid var(--line-1)",
  background: "transparent",
  color: "var(--fg-2)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  cursor: "pointer",
  textAlign: "left",
  boxSizing: "border-box",
  transition: HOVER_TRANSITION,
};

const NAV_LABEL_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// The two hover-revealed controls at the row's right edge (create + caret).
const ROW_ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  flexShrink: 0,
  transition: "opacity var(--duration-fast) var(--ease-standard)",
};

const ICON_BTN_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  padding: 0,
  flexShrink: 0,
  background: "transparent",
  border: 0,
  borderRadius: "var(--radius-1)",
  color: "var(--fg-3)",
  cursor: "pointer",
  transition: HOVER_TRANSITION,
};

// Flyout — a body-level portal opening to the RIGHT of the row.
const FLYOUT_STYLE: CSSProperties = {
  position: "fixed",
  width: 280,
  maxHeight: "min(360px, calc(100vh - 16px))",
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-2)",
  zIndex: 60,
  overflow: "hidden",
};

const SEARCH_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-3)",
  borderBottom: "1px solid var(--line-1)",
  color: "var(--fg-3)",
  flexShrink: 0,
};

const SEARCH_INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 0,
  outline: "none",
  background: "transparent",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--fg-1)",
};

const LIST_STYLE: CSSProperties = {
  overflowY: "auto",
  padding: "var(--space-1) var(--space-1)",
};

const ROW_BASE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  height: 30,
  padding: "0 8px",
  boxSizing: "border-box",
  borderRadius: 6,
  background: "transparent",
  border: 0,
  color: "var(--fg-1)",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  textAlign: "left",
};

const ROW_LABEL_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const RENAME_INPUT_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  padding: "2px 4px",
  background: "var(--bg-2)",
  color: "var(--fg-1)",
  // Clean inline edit: soft accent halo instead of a hard border + the global
  // focus ring (the inline boxShadow overrides `--ring`).
  border: "1px solid transparent",
  borderRadius: 3,
  outline: "none",
  boxShadow: "0 0 0 2px var(--accent-soft)",
};

const EMPTY_HINT_STYLE: CSSProperties = {
  padding: "10px 12px",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--fg-3)",
};

const viewLabel = (view: SavedView, untitled: string): string =>
  view.name.trim() === "" ? untitled : view.name;

/** One saved-view row inside the flyout — opens on click, right-click for the
 *  action menu, or an inline rename input when this row is being renamed. */
function ViewRow({
  view,
  renaming,
  active,
  onOpen,
  onContextMenu,
  onCommitRename,
  onCancelRename,
}: {
  view: SavedView;
  renaming: boolean;
  /** This view is the one currently open in the focused pane. */
  active: boolean;
  onOpen: (id: string) => void;
  onContextMenu: (e: ReactMouseEvent, id: string) => void;
  onCommitRename: (id: string, name: string) => void;
  onCancelRename: () => void;
}) {
  const { t } = useTranslation();
  const label = viewLabel(view, t("notes.views.untitledView"));

  if (renaming) {
    return (
      <div style={{ ...ROW_BASE_STYLE, cursor: "default" }}>
        <span
          aria-hidden="true"
          style={{ display: "flex", flexShrink: 0, color: "var(--fg-3)" }}
        >
          <Icon name="layout-grid" size={14} />
        </span>
        <input
          type="text"
          data-testid="views.rename-input"
          defaultValue={view.name}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => onCommitRename(view.id, e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitRename(view.id, e.currentTarget.value);
            else if (e.key === "Escape") onCancelRename();
          }}
          style={RENAME_INPUT_STYLE}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      role="menuitem"
      data-testid="views.row"
      data-view-id={view.id}
      data-active={active ? "true" : undefined}
      title={label}
      onClick={() => onOpen(view.id)}
      onContextMenu={(e) => onContextMenu(e, view.id)}
      {...hoverSurface()}
      style={ROW_BASE_STYLE}
    >
      <span
        aria-hidden="true"
        style={{ display: "flex", flexShrink: 0, color: "var(--fg-3)" }}
      >
        <Icon name="layout-grid" size={14} />
      </span>
      <span style={ROW_LABEL_STYLE}>{label}</span>
      {active && (
        <span
          aria-hidden="true"
          style={{ display: "flex", flexShrink: 0, color: "var(--accent)" }}
        >
          <Icon name="check" size={14} />
        </span>
      )}
    </button>
  );
}

/**
 * The sidebar "Views" entry. `views` is already in display order (the caller
 * applies `view_order`). `onOpenView` opens a view tab; `onNewView` creates a
 * blank view; `onRename`/`onDelete`/`onMoveView` are the task-6 management
 * dispatches (the caller persists via #3's API + refreshes).
 */
export function ViewsSection({
  views,
  activeViewId = null,
  onOpenView,
  onNewView,
  onEditFilter,
  onViewSettings,
  onRename,
  onDelete,
  onMoveView,
}: {
  views: readonly SavedView[];
  /** The view currently open in the focused pane — flagged with a checkmark in
   *  the flyout list so it is clear which one is showing. `null` = a note (or
   *  nothing) is focused. */
  activeViewId?: string | null;
  onOpenView: (id: string) => void;
  onNewView: () => void;
  onEditFilter: (id: string) => void;
  /** Open the cards display-settings modal (cover image / aspect / card size).
   *  Only offered for `view_type === "cards"` views. */
  onViewSettings: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onMoveView: (id: string, dir: -1 | 1) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(
    null,
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number }>({
    left: 0,
    bottom: 0,
  });
  // Light open animation: mount hidden, flip on the next frame so the fade+rise
  // transition plays (reduced-motion zeroes it globally).
  const [visible, setVisible] = useState(false);

  const openFlyout = () => {
    setQuery("");
    setOpen(true);
  };

  // Anchor the flyout just to the RIGHT of the row and BOTTOM-aligned to it, so
  // it hangs off the Views row (which sits low in the sidebar) and grows upward
  // — reading as a popover attached to the row, not floating loose.
  useLayoutEffect(() => {
    if (!open) {
      setVisible(false);
      return;
    }
    const el = rowRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right + 6, window.innerWidth - 280 - 8));
    const bottom = Math.max(8, window.innerHeight - r.bottom);
    setPos({ left, bottom });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Focus the search box once the flyout is up so typing filters immediately.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Outside-click / Esc close. While a row's context menu is open, ignore
  // outside clicks (the menu is its own portal and owns its dismissal), so
  // right-clicking a row doesn't collapse the flyout underneath it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (menu !== null) return;
      const target = e.target as Node;
      if (flyoutRef.current?.contains(target)) return;
      if (rowRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const id = window.setTimeout(
      () => document.addEventListener("mousedown", onDown),
      0,
    );
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, menu]);

  // Reveal-on-request (SYNC-7): the BottomBar `editor.views-cta` + `views.show`
  // palette action fire `requestRevealViews()`. Open the flyout, bring the row
  // into view, and flash it so the click always lands somewhere visible.
  const nonce = useRevealViewsNonce();
  useEffect(() => {
    if (!consumeRevealViews()) return;
    rowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    openFlyout();
    setHighlight(true);
    const timer = setTimeout(() => setHighlight(false), 1100);
    return () => clearTimeout(timer);
  }, [nonce]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return views;
    return views.filter((v) =>
      viewLabel(v, t("notes.views.untitledView")).toLowerCase().includes(q),
    );
  }, [views, query, t]);

  const openMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, id });
  };

  const openView = (id: string) => {
    setOpen(false);
    onOpenView(id);
  };

  // "View settings…" applies to every view type now — it hosts the view_type
  // picker + group / sort / column config (not just the cards cover settings).
  const menuItems: ContextMenuItem[] = menu
    ? [
        {
          id: "edit-filter",
          label: t("notes.views.menu.editFilter"),
          group: "edit",
          onSelect: () => onEditFilter(menu.id),
        },
        {
          id: "view-settings",
          label: t("notes.views.menu.viewSettings"),
          group: "edit",
          onSelect: () => onViewSettings(menu.id),
        },
        {
          id: "rename",
          label: t("notes.views.menu.rename"),
          group: "edit",
          onSelect: () => setRenamingId(menu.id),
        },
        {
          id: "move-up",
          label: t("notes.views.menu.moveUp"),
          group: "reorder",
          onSelect: () => onMoveView(menu.id, -1),
        },
        {
          id: "move-down",
          label: t("notes.views.menu.moveDown"),
          group: "reorder",
          onSelect: () => onMoveView(menu.id, 1),
        },
        {
          id: "delete",
          label: t("notes.views.menu.deleteView"),
          group: "danger",
          destructive: true,
          onSelect: () => onDelete(menu.id),
        },
      ]
    : [];

  const commitRename = (id: string, name: string) => {
    setRenamingId(null);
    const trimmed = name.trim();
    const view = views.find((v) => v.id === id);
    if (view !== undefined && trimmed !== "" && trimmed !== view.name) {
      onRename(id, trimmed);
    }
  };

  const actionsVisible = hovering || open;

  return (
    <>
      <div
        ref={rowRef}
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("notes.views.heading")}
        data-testid="views.section"
        data-revealed={highlight ? "true" : undefined}
        onClick={() => (open ? setOpen(false) : openFlyout())}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openFlyout();
          }
        }}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        style={{
          ...NAV_ROW_STYLE,
          background:
            open || highlight
              ? "var(--paper-3)"
              : hovering
                ? "var(--bg-3)"
                : "transparent",
          boxShadow: highlight ? "inset 0 0 0 1px var(--accent)" : undefined,
        }}
      >
        <span
          aria-hidden="true"
          style={{ display: "flex", flexShrink: 0, color: "var(--fg-3)" }}
        >
          <Icon name="layout-grid" size={15} />
        </span>
        <span style={NAV_LABEL_STYLE}>{t("notes.views.heading")}</span>
        <span
          style={{
            ...ROW_ACTIONS_STYLE,
            opacity: actionsVisible ? 1 : 0,
            pointerEvents: actionsVisible ? "auto" : "none",
          }}
        >
          <button
            type="button"
            data-testid="views.new-button"
            aria-label={t("notes.views.newView")}
            title={t("notes.views.newView")}
            onClick={(e) => {
              e.stopPropagation();
              // Creating opens the full filter-builder modal; close the flyout so
              // it isn't left hanging behind (and its outside-click dismissal
              // doesn't fight the modal).
              setOpen(false);
              onNewView();
            }}
            {...hoverSurface()}
            style={ICON_BTN_STYLE}
          >
            <Icon name="file-plus" size={14} />
          </button>
          <button
            type="button"
            data-testid="views.flyout-toggle"
            aria-label={t("notes.views.expandViews")}
            title={t("notes.views.expandViews")}
            onClick={(e) => {
              e.stopPropagation();
              open ? setOpen(false) : openFlyout();
            }}
            {...hoverSurface()}
            style={ICON_BTN_STYLE}
          >
            <Icon name="chevron-right" size={14} />
          </button>
        </span>
      </div>

      {open &&
        createPortal(
          <div
            ref={flyoutRef}
            role="menu"
            data-testid="views.flyout"
            style={{
              ...FLYOUT_STYLE,
              left: pos.left,
              bottom: pos.bottom,
              transformOrigin: "bottom left",
              opacity: visible ? 1 : 0,
              transform: visible ? "translateY(0)" : "translateY(6px)",
              transition:
                "opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out)",
            }}
          >
            <div style={SEARCH_ROW_STYLE}>
              <Icon name="search" size={14} />
              <input
                ref={searchRef}
                type="text"
                value={query}
                placeholder={t("notes.views.searchPlaceholder")}
                aria-label={t("notes.views.searchPlaceholder")}
                data-testid="views.search"
                style={SEARCH_INPUT_STYLE}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setOpen(false);
                }}
              />
            </div>
            <div style={LIST_STYLE}>
              {filtered.length === 0 ? (
                <div style={EMPTY_HINT_STYLE} data-testid="views.empty">
                  {query.trim() === ""
                    ? t("notes.views.empty")
                    : t("notes.views.noMatch")}
                </div>
              ) : (
                filtered.map((view) => (
                  <ViewRow
                    key={view.id}
                    view={view}
                    renaming={renamingId === view.id}
                    active={view.id === activeViewId}
                    onOpen={openView}
                    onContextMenu={openMenu}
                    onCommitRename={commitRename}
                    onCancelRename={() => setRenamingId(null)}
                  />
                ))
              )}
            </div>
          </div>,
          document.body,
        )}

      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
