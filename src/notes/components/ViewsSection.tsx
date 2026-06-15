// `<ViewsSection>` — the sidebar "Views" block (Saved Views #4, MYND-274,
// tasks 3 + 6). A collapsible section peer to Favorites / Notes / Trash that
// lists the vault's saved views; clicking a row opens that view as a workspace
// tab (`ws.openView`). Right-click a row → rename / delete / move up / move
// down (task 6). Sits between the Notes tree and the Attachments/Trash footer.
//
// Design canon: Penpot frame `screen------views--sidebar-section (MYND-274)`
// (approved). Empty-state = a quiet discoverable hint (not an absent section).
// Leading glyph `layout-grid` (saved views render as table/cards/grid).
//
// Scope: rows open-on-click (task 3) + context-menu rename/delete + move-up/down
// reorder (task 6). The view's filter/sort/group editing (builder widgets) is a
// later follow-on; the leading "+ New view" creates a blank view (task 3/5).

import {
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Icon } from "../../components/primitives/Icon";
import { IconButton } from "../../components/primitives/IconButton";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { SECTION_HEADING_STYLE } from "./sharedStyles";
import type { SavedView } from "../../lib/prefs";

const HEADER_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 14px 4px",
  flexShrink: 0,
};

const HEADER_LEAD_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const CHEVRON_BUTTON_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 18,
  height: 18,
  padding: 0,
  background: "transparent",
  border: 0,
  color: "var(--fg-3)",
  cursor: "pointer",
};

const ROW_BASE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  height: 32,
  padding: "0 8px",
  margin: "0 6px",
  boxSizing: "border-box",
  borderRadius: 3,
  background: "transparent",
  border: 0,
  color: "var(--fg-2)",
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
  background: "var(--bg-1)",
  color: "var(--fg-1)",
  border: "1px solid var(--accent)",
  borderRadius: 3,
  outline: "none",
};

const EMPTY_HINT_STYLE: CSSProperties = {
  padding: "2px 16px 8px",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--fg-3)",
};

const viewLabel = (view: SavedView): string =>
  view.name.trim() === "" ? "Untitled view" : view.name;

/** One saved-view row — opens on click, right-click for the action menu, or an
 *  inline rename input when this row is being renamed. */
function ViewRow({
  view,
  renaming,
  onOpen,
  onContextMenu,
  onCommitRename,
  onCancelRename,
}: {
  view: SavedView;
  renaming: boolean;
  onOpen: (id: string) => void;
  onContextMenu: (e: ReactMouseEvent, id: string) => void;
  onCommitRename: (id: string, name: string) => void;
  onCancelRename: () => void;
}) {
  const [hovering, setHovering] = useState(false);
  const label = viewLabel(view);

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
      role="tab"
      data-testid="views.row"
      data-view-id={view.id}
      title={label}
      onClick={() => onOpen(view.id)}
      onContextMenu={(e) => onContextMenu(e, view.id)}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        ...ROW_BASE_STYLE,
        background: hovering ? "var(--paper-3)" : "transparent",
      }}
    >
      <span
        aria-hidden="true"
        style={{ display: "flex", flexShrink: 0, color: "var(--fg-3)" }}
      >
        <Icon name="layout-grid" size={14} />
      </span>
      <span style={ROW_LABEL_STYLE}>{label}</span>
    </button>
  );
}

/**
 * The sidebar "Views" section. `views` is already in display order (the caller
 * applies `view_order`). `onOpenView` opens a view tab; `onNewView` creates a
 * blank view; `onRename`/`onDelete`/`onMoveView` are the task-6 management
 * dispatches (the caller persists via #3's API + refreshes). Collapse is local.
 */
export function ViewsSection({
  views,
  onOpenView,
  onNewView,
  onRename,
  onDelete,
  onMoveView,
}: {
  views: readonly SavedView[];
  onOpenView: (id: string) => void;
  onNewView: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onMoveView: (id: string, dir: -1 | 1) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(
    null,
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const openMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, id });
  };

  const menuItems: ContextMenuItem[] = menu
    ? [
        {
          id: "rename",
          label: "Rename",
          onSelect: () => setRenamingId(menu.id),
        },
        {
          id: "move-up",
          label: "Move up",
          onSelect: () => onMoveView(menu.id, -1),
        },
        {
          id: "move-down",
          label: "Move down",
          onSelect: () => onMoveView(menu.id, 1),
        },
        {
          id: "delete",
          label: "Delete view",
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
    <div style={{ flexShrink: 0 }} data-testid="views.section">
      <div style={HEADER_ROW_STYLE}>
        <div style={HEADER_LEAD_STYLE}>
          <button
            type="button"
            aria-label={collapsed ? "Expand views" : "Collapse views"}
            aria-expanded={!collapsed}
            data-testid="views.collapse-toggle"
            onClick={() => setCollapsed((v) => !v)}
            style={CHEVRON_BUTTON_STYLE}
          >
            <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={14} />
          </button>
          <div style={SECTION_HEADING_STYLE}>Views</div>
        </div>
        <IconButton
          icon="file-plus"
          label="New view"
          testId="views.new-button"
          onClick={onNewView}
        />
      </div>
      {!collapsed &&
        (views.length === 0 ? (
          <div style={EMPTY_HINT_STYLE} data-testid="views.empty">
            No views yet. Save the current note list as a view.
          </div>
        ) : (
          <div>
            {views.map((view) => (
              <ViewRow
                key={view.id}
                view={view}
                renaming={renamingId === view.id}
                onOpen={onOpenView}
                onContextMenu={openMenu}
                onCommitRename={commitRename}
                onCancelRename={() => setRenamingId(null)}
              />
            ))}
          </div>
        ))}
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
