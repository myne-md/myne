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

import { useCallback, useEffect, useMemo, useReducer, useState, type CSSProperties, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { COMMAND_ACTIONS } from "../../commands";
import { Icon } from "../../components/primitives/Icon";
import { hoverSurface, HOVER_TRANSITION } from "../../components/primitives/hoverSurface";
import { setRibbonItems } from "../../lib/prefs";
import { VIEWS_ENABLED_EVENT } from "../../lib/viewsEnabled";
import { usePrefs } from "../../hooks/usePrefs";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { STRIP_HEIGHT } from "./TabStrip";
import { dragRegionProps } from "../../screens/titlebar";
import { resolveRibbonItems, ribbonEligibleIds } from "../ribbonItems";
import { ribbonCommands } from "../ribbonCommands";
import { Tooltip } from "../../components/primitives/Tooltip";
import { BINDABLE_COMMANDS } from "../../commands/bindableCatalog";
import { effectiveChords } from "../../commands/keymap";
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
/** The current-surface indicator: an accent bar on the rail's inline-start
 *  edge, the conventional nav-rail "you are here". Drawn on the ITEM rather
 *  than the button so it reaches the rail edge, and kept distinct from the
 *  button's background because that is already the drag/hover channel — two
 *  states sharing one paint is how a dragged item would read as the current
 *  surface. */
const CURRENT_BAR_STYLE: CSSProperties = {
  position: "absolute",
  insetInlineStart: 0,
  top: 4,
  bottom: 4,
  width: 2,
  borderRadius: "var(--radius-1)",
  background: "var(--accent)",
  pointerEvents: "none",
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

function buttonStyle(
  dimmed: boolean,
  active: boolean,
  current: boolean,
): CSSProperties {
  return {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    border: 0,
    borderRadius: "var(--radius-1)",
    background: active || current ? "var(--bg-3)" : "transparent",
    // The current surface's glyph takes full-strength ink, so the rail reads at
    // a glance rather than only on close inspection of a 2px bar.
    color: dimmed ? "var(--fg-3)" : current ? "var(--fg-1)" : "var(--fg-2)",
    cursor: dimmed ? "default" : "pointer",
    opacity: dimmed ? 0.5 : 1,
    transition: HOVER_TRANSITION,
  };
}

export function LeftRibbon({
  hidden = false,
  currentCommandId,
}: {
  hidden?: boolean;
  /**
   * The registry command whose SURFACE is the focused tab, or `undefined` when
   * the focused tab is a note or a saved view (neither is opened by a rail
   * entry). Derived by the caller from `ws.focusedLeaf.activeTab?.kind` through
   * `openCommandForKind`, so the rail never keeps its own idea of where you
   * are — which is the bug: the rail had NO active state, so pressing
   * Attachments and pressing Graph left it identical (myne-md/myne#773).
   */
  currentCommandId?: string;
}) {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const [dragId, setDragId] = useState<string | null>(null);
  const isCurrent = (id: string): boolean =>
    currentCommandId !== undefined && currentCommandId === id;

  // The EFFECTIVE chord, not `action.kbd` — which the registry's own doc calls
  // "display only, NOT a binding source of truth" and which is a hand-written
  // string that cannot follow a rebind. The rail is a column of glyphs whose
  // entire vocabulary is otherwise invisible, so the tooltip is where this app
  // teaches its shortcuts; teaching the wrong one is worse than teaching none,
  // which is why an unbound command shows no caps rather than a guess.
  const chordFor = (id: string): string | undefined => {
    const bindable = BINDABLE_COMMANDS.find((c) => c.id === id);
    if (bindable === undefined) return undefined;
    const defaults: Record<string, string[]> = {};
    for (const c of BINDABLE_COMMANDS) defaults[c.id] = c.defaultBindings;
    return effectiveChords(id, defaults, prefs.keymap)[0];
  };
  const [dropAt, setDropAt] = useState<{ id: string; edge: "before" | "after" } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [bgMenu, setBgMenu] = useState<{ x: number; y: number } | null>(null);

  // A pinned command's visibility can depend on a DEVICE-LOCAL pref, which
  // `usePrefs` (vault prefs) does not carry — so the rail would keep showing a
  // button whose surface has just been switched off. `views.show` is the one
  // today (Settings → Editor → Views, myne-md/myne#762); its writer fires this
  // event for exactly this reason, so re-read on it.
  const [, bumpDeviceLocal] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const onChange = () => bumpDeviceLocal();
    window.addEventListener(VIEWS_ENABLED_EVENT, onChange);
    return () => window.removeEventListener(VIEWS_ENABLED_EVENT, onChange);
  }, []);

  const eligible = useMemo(() => ribbonEligibleIds(), []);
  const byId = useMemo(() => new Map(COMMAND_ACTIONS.map((a) => [a.id, a])), []);
  const stored = useMemo(
    () => resolveRibbonItems(prefs.ribbon_items, eligible),
    [prefs.ribbon_items, eligible],
  );

  // Optimistic reorder: the write round-trips through the prefs nonce, so the
  // rail would otherwise sit on the old order until the re-read lands. A failed
  // write clears the override, which rolls back to the stored order the failed
  // write never changed.
  const [pending, setPending] = useState<string[] | null>(null);
  const items = pending ?? stored;
  // Once the stored prefs catch up to an optimistic write, drop the override
  // so later external changes (a palette pin) flow through again. Compared by
  // value: the nonce re-read is async, and clearing on write-settle instead
  // would flash the old order.
  useEffect(() => {
    if (
      pending !== null &&
      pending.length === stored.length &&
      pending.every((id, i) => stored[i] === id)
    ) {
      setPending(null);
    }
  }, [pending, stored]);

  const persist = useCallback((next: string[]) => {
    setPending(next);
    void setRibbonItems(next).catch(() => setPending(null));
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
            {isCurrent(id) && <span aria-hidden style={CURRENT_BAR_STYLE} />}
            {showDrop && dropAt.edge === "before" && (
              <span aria-hidden className="myne-drop-line" data-edge="before" />
            )}
            {showDrop && dropAt.edge === "after" && (
              <span aria-hidden className="myne-drop-line" data-edge="after" />
            )}
            <Tooltip label={label} kbd={chordFor(id)} placement="bottom">
            <button
              type="button"
              aria-label={label}
              // `page` rather than `true`: the rail is navigation between
              // surfaces, and a screen reader saying "current page" is the
              // right sentence for "this is the one you are looking at".
              aria-current={isCurrent(id) ? "page" : undefined}
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
              style={{
                ...buttonStyle(dimmed, dragId === id, isCurrent(id)),
                opacity: dragId === id ? 0.4 : dimmed ? 0.5 : 1,
              }}
              data-testid="editor.ribbon.button"
              data-command-id={id}
              data-visibility={vis}
            >
              <Icon name={action.ribbon!.icon} size={ICON_SIZE} />
            </button>
            </Tooltip>
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
