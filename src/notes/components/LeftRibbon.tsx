// Left ribbon (myne-md/myne#699).
//
// A slim far-left icon column, independent of the notes sidebar, rendering the
// user's pinned registry commands. It lives in the Editor's three-pane row, but
// the command CONTEXT it needs is built inside `CommandPaletteHost`, a sibling
// subtree, so running and state-visibility go through the `ribbonCommands`
// service locator (the `sidebarCommands` pattern). Display metadata (label,
// icon, disabledHint) comes straight off `COMMAND_ACTIONS`.
//
// State reactivity is the palette's own rule, applied per button: a command that
// resolves to `hidden` drops out of the rail and the others reflow, a `disabled`
// command stays dimmed with its hint, and `show` is live.

import { useCallback, useMemo, useState, type CSSProperties, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { COMMAND_ACTIONS } from "../../commands";
import { Icon } from "../../components/primitives/Icon";
import { hoverSurface, HOVER_TRANSITION } from "../../components/primitives/hoverSurface";
import { setRibbonItems } from "../../lib/prefs";
import { usePrefs } from "../../hooks/usePrefs";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { STRIP_HEIGHT } from "./TabStrip";
import { dragRegionProps } from "../../screens/titlebar";
import { resolveRibbonItems, ribbonEligibleIds } from "../ribbonItems";
import { ribbonCommands } from "../ribbonCommands";
import { reorderByDrop, moveBarItem } from "../barItemsOrder";

/** Column width in px. Slim, icon-only; the design canon has no rail token. */
const RAIL_WIDTH = 40;
const BUTTON_SIZE = 28;
const ICON_SIZE = 17;

/**
 * The shell spans the full row height so the rail's surface and its inner
 * divider line can start BELOW the traffic-light strip rather than running up
 * through it (the `STRIP_HEIGHT` spacer mirrors the left sidebar's own
 * clearance row). Obsidian's ribbon does the same: the window controls sit in a
 * title strip above the rail, not on top of it.
 */
const RAIL_SHELL_STYLE: CSSProperties = {
  position: "relative",
  alignSelf: "stretch",
  width: RAIL_WIDTH,
  flexShrink: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};
const RAIL_BODY_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--space-1)",
  paddingTop: "var(--space-1)",
  paddingBottom: "var(--space-1)",
  overflowY: "auto",
  overflowX: "hidden",
  background: "var(--bg-2)",
};
/** One rail item: a relative, full-width flex centre so the drop indicator can
 *  be an absolutely-positioned, square accent line rather than an inset shadow
 *  that follows the button's rounded corners. */
const RAIL_ITEM_STYLE: CSSProperties = {
  position: "relative",
  width: "100%",
  display: "flex",
  justifyContent: "center",
};
const DROP_LINE_STYLE: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  height: 2,
  background: "var(--accent)",
  pointerEvents: "none",
  zIndex: 1,
};

/** The divider, drawn explicitly so it starts exactly at `STRIP_HEIGHT` (below
 *  the traffic lights) instead of being a border on a box whose bounds are easy
 *  to get subtly wrong under the flex stack. */
const RAIL_DIVIDER_STYLE: CSSProperties = {
  position: "absolute",
  top: STRIP_HEIGHT,
  bottom: 0,
  insetInlineEnd: 0,
  width: 1,
  background: "var(--line-1)",
  pointerEvents: "none",
};

function buttonStyle(dimmed: boolean, active: boolean): CSSProperties {
  return {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    border: 0,
    borderRadius: "var(--radius-1)",
    background: active ? "var(--bg-3)" : "transparent",
    color: dimmed ? "var(--fg-3)" : "var(--fg-2)",
    cursor: dimmed ? "default" : "pointer",
    opacity: dimmed ? 0.5 : 1,
    transition: HOVER_TRANSITION,
  };
}

export function LeftRibbon({ hidden = false }: { hidden?: boolean }) {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; edge: "before" | "after" } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [bgMenu, setBgMenu] = useState<{ x: number; y: number } | null>(null);

  const eligible = useMemo(() => ribbonEligibleIds(), []);
  const byId = useMemo(() => new Map(COMMAND_ACTIONS.map((a) => [a.id, a])), []);
  const items = useMemo(
    () => resolveRibbonItems(prefs.ribbon_items, eligible),
    [prefs.ribbon_items, eligible],
  );

  const persist = useCallback((next: string[]) => {
    // Best-effort: the rail has no error surface of its own. A failed write is
    // surfaced by the Appearance roster, which shows `errorSave` and rolls back.
    void setRibbonItems(next).catch(() => {});
  }, []);

  if (hidden || !prefs.ribbon_visible) return null;

  const visible = items.filter((id) => (ribbonCommands.visibility?.(id) ?? "show") !== "hidden");

  function onDragOver(e: DragEvent, id: string) {
    if (dragId === null || dragId === id) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const edge = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setDropAt({ id, edge });
  }

  function onDrop(id: string) {
    if (dragId !== null && dragId !== id && dropAt !== null) {
      persist(reorderByDrop(items, dragId, dropAt.id, dropAt.edge));
    }
    setDragId(null);
    setDropAt(null);
  }

  function onKeyDown(e: React.KeyboardEvent, id: string) {
    // Keyboard reorder fallback for the drag gesture (the a11y contract the
    // floating-toolbar customization established).
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    persist(moveBarItem(items, visible, id, e.key === "ArrowUp" ? -1 : 1));
  }

  return (
    <div style={RAIL_SHELL_STYLE}>
      {/* Title-strip clearance: keeps the rail's icons and its divider line below
          the macOS traffic lights / floated toggles, and stays draggable. */}
      <div
        {...dragRegionProps()}
        aria-hidden
        style={{
          height: STRIP_HEIGHT,
          flexShrink: 0,
          // Continues the title-band rule across the rail so it meets the tab
          // strip's bottom border in one line.
          borderBottom: "1px solid var(--line-1)",
        }}
      />
      <span aria-hidden style={RAIL_DIVIDER_STYLE} />
      <div
        role="toolbar"
        aria-orientation="vertical"
        aria-label={t("editor.ribbon.label")}
        data-testid="editor.ribbon"
        style={RAIL_BODY_STYLE}
        onContextMenu={(e) => {
          e.preventDefault();
          setBgMenu({ x: e.clientX, y: e.clientY });
        }}
      >
      {visible.map((id) => {
        const action = byId.get(id);
        if (action === undefined) return null;
        const vis = ribbonCommands.visibility?.(id) ?? "show";
        const dimmed = vis === "disabled";
        const label = action.disabledHint !== undefined && dimmed ? action.disabledHint : action.label;
        const hover = hoverSurface({ disabled: dimmed });
        const showDrop = dropAt?.id === id;
        return (
          <div key={id} style={RAIL_ITEM_STYLE}>
            {showDrop && dropAt.edge === "before" && <span aria-hidden style={{ ...DROP_LINE_STYLE, top: -1 }} />}
            {showDrop && dropAt.edge === "after" && <span aria-hidden style={{ ...DROP_LINE_STYLE, bottom: -1 }} />}
            <button
              type="button"
              title={action.kbd !== undefined ? `${label} (${action.kbd})` : label}
              aria-label={label}
              aria-disabled={dimmed || undefined}
              disabled={dimmed}
              draggable
              onDragStart={() => setDragId(id)}
              onDragEnd={() => {
                setDragId(null);
                setDropAt(null);
              }}
              onDragOver={(e) => onDragOver(e, id)}
              onDrop={() => onDrop(id)}
              onKeyDown={(e) => onKeyDown(e, id)}
              onClick={() => {
                if (!dimmed) ribbonCommands.run?.(id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ id, x: e.clientX, y: e.clientY });
              }}
              {...hover}
              style={{ ...buttonStyle(dimmed, dragId === id), opacity: dragId === id ? 0.4 : dimmed ? 0.5 : 1 }}
              data-testid="editor.ribbon.button"
              data-command-id={id}
              data-visibility={vis}
            >
              <Icon name={action.ribbon!.icon} size={ICON_SIZE} />
            </button>
          </div>
        );
      })}
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              id: "unpin",
              label: t("editor.ribbon.unpin"),
              onSelect: () => persist(items.filter((x) => x !== menu.id)),
            } satisfies ContextMenuItem,
            {
              id: "customize",
              group: "edit",
              label: t("editor.ribbon.customize"),
              onSelect: () => ribbonCommands.customizeRibbon?.(),
            } satisfies ContextMenuItem,
          ]}
        />
      )}
      {bgMenu !== null && (
        <ContextMenu
          x={bgMenu.x}
          y={bgMenu.y}
          onClose={() => setBgMenu(null)}
          items={[
            {
              id: "customize",
              label: t("editor.ribbon.customize"),
              onSelect: () => ribbonCommands.customizeRibbon?.(),
            } satisfies ContextMenuItem,
          ]}
        />
      )}
      </div>
    </div>
  );
}
