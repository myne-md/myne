// `<ViewsSection>` — the saved-views flyout (Saved Views #4, MYND-274).
//
// It used to be a nav ROW in the notes sidebar, styled like the Attachments /
// Trash / Archive footer entries, that opened a flyout beside itself. The row is
// gone (myne-md/myne#762): the `views.show` registry command is the one entry
// point, pinned on the left ribbon by default and reachable from the palette, so
// the sidebar footer is no longer a second unremovable copy of the rail.
//
// What is left renders nothing of its own and hosts the flyout — a scrollable,
// searchable panel listing every saved view, with the create (+) control that
// used to sit on the row now in its header. It still mounts inside the sidebar
// because the view list and the management dispatches it needs live there; the
// flyout itself is a body-level portal anchored to whatever invoked it.
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
import { Button } from "../../components/primitives/Button";
import { Input } from "../../components/primitives/Input";
import { IconButton } from "../../components/primitives/IconButton";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import type { SavedView } from "../../lib/prefs";
import {
  consumeRevealViews,
  useRevealViewsNonce,
} from "../views/revealViewsSignal";

/** The left-ribbon button for `views.show`, this flyout's anchor. Selected by
 *  the rail's own `data-command-id` contract (LeftRibbon), not by a testid, so
 *  it is a product attribute rather than a test hook. */
const RIBBON_ANCHOR_SELECTOR = '[data-command-id="views.show"]';

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
  fontSize: "var(--text-sm)",
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
  borderRadius: "var(--radius-2)",
  background: "transparent",
  border: 0,
  color: "var(--fg-1)",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  textAlign: "start",
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
  fontSize: "var(--text-sm)",
  padding: "2px 4px",
  background: "var(--bg-2)",
  color: "var(--fg-1)",
  // Clean inline edit: soft accent halo instead of a hard border + the global
  // focus ring (the inline boxShadow overrides `--ring`).
  border: "1px solid transparent",
  borderRadius: "var(--radius-1)",
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
        <Input
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
    <Button
      variant="ghost"
      role="menuitem"
      data-testid="views.row"
      data-view-id={view.id}
      data-active={active ? "true" : undefined}
      title={label}
      onClick={() => onOpen(view.id)}
      onContextMenu={(e) => onContextMenu(e, view.id)}
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
    </Button>
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
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(
    null,
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number }>({
    left: 0,
    bottom: 0,
  });
  // Light open animation: mount hidden, flip on the next frame so the fade+rise
  // transition plays (reduced-motion zeroes it globally).
  const [visible, setVisible] = useState(false);

  // Anchor the flyout just to the RIGHT of whatever invoked it and BOTTOM-aligned
  // to it, so it reads as a popover attached to that control rather than floating
  // loose. The anchor used to be this component's own sidebar row; with the row
  // gone (myne-md/myne#762) it is the ribbon's `views.show` button, found in the
  // DOM rather than threaded through, because the two live in sibling subtrees
  // and both entry points (ribbon click, palette) come through the same
  // anchor-less `requestRevealViews` signal. A user who unpinned the button — or
  // hid the rail — leaves nothing to hang off, so the flyout falls back to the
  // bottom-left corner of the window, which is where the rail would have been.
  useLayoutEffect(() => {
    if (!open) {
      setVisible(false);
      return;
    }
    const el = document.querySelector<HTMLElement>(RIBBON_ANCHOR_SELECTOR);
    const r = el?.getBoundingClientRect();
    const right = r?.right ?? 8;
    const anchorBottom = r?.bottom ?? window.innerHeight - 8;
    const left = Math.max(8, Math.min(right + 6, window.innerWidth - 280 - 8));
    const bottom = Math.max(8, window.innerHeight - anchorBottom);
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
      // The ribbon button is the anchor: let ITS click handler run the command
      // (which toggles), instead of this listener closing the flyout first and
      // the command immediately reopening it.
      if ((target as Element).closest?.(RIBBON_ANCHOR_SELECTOR) !== null) return;
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

  // Reveal-on-request (SYNC-7): the ribbon / palette `views.show` action and the
  // BottomBar `editor.views-cta` all fire `requestRevealViews()`. There is no row
  // to scroll to or flash any more, so a request simply toggles the flyout — a
  // second press on the same ribbon button closes it, which is what a rail
  // toggle is expected to do.
  const nonce = useRevealViewsNonce();
  useEffect(() => {
    if (!consumeRevealViews()) return;
    setOpen((was) => {
      if (!was) setQuery("");
      return !was;
    });
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
    // A row's primary action must not run while its context menu is open.
    // WebKitGTK emits a real `click` after a right-click's `contextmenu` —
    // measured sequence: pointerdown:b2 → mousedown:b2 → contextmenu:b2 →
    // mouseup:b0 → click:b0 — and that click lands on the row's `onClick` →
    // here → `setOpen(false)`, collapsing the flyout out from under the open
    // menu. That is what left the rename input unrenderable (saved-views-entry
    // sv1): the menu was up but its own flyout had gone. `menu` is set by
    // `openMenu` before the synthesized click arrives, so guarding on it is
    // deterministic and needs no timing window. The menu owns its own
    // dismissal; a genuine row click happens with `menu === null`.
    if (menu !== null) return;
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
          label: t("common.rename"),
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

  return (
    <>
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
              <Input
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
              <IconButton
                icon="file-plus"
                iconSize={14}
                label={t("notes.views.newView")}
                tooltip
                testId="views.new-button"
                onClick={() => {
                  // Creating opens the full filter-builder modal; close the
                  // flyout so it isn't left hanging behind (and its
                  // outside-click dismissal doesn't fight the modal).
                  setOpen(false);
                  onNewView();
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
