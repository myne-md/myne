// `<ContextMenu>` — minimal right-click menu for sidebar row actions.
//
// Surfaces the two row-action items locked by the 2026-05-15 MYND-82
// grill Q14: "Rename" + "Delete". The component is intentionally lean
// — no portal, no fancy positioning library; absolute-positioned at
// the click coordinates with viewport-edge clamping. A future v0.2
// PRD may extract a generic `<Menu>` primitive.
//
// PRD stories: 26 (right-click context menu surfaces Rename + Delete).
//
// Dismissal:
// - Esc keydown → onClose.
// - Click outside (document-level mousedown handler) → onClose.
// - Click on an item → fires its action then onClose.

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Icon } from "../../components/primitives/Icon";

export type ContextMenuItem = {
  /** Stable id; used as React key and for test queries. */
  id: string;
  /** Visible label. */
  label: string;
  /**
   * Logical group tag. A divider is drawn between two adjacent items whose
   * `group` differs, so callers separate the menu into sections (open / edit /
   * organize / destructive, Obsidian-style) just by tagging items — no explicit
   * separator entries. `undefined` groups with its neighbours (no divider).
   */
  group?: string;
  /** Optional `var(--*)` color override for destructive items. */
  destructive?: boolean;
  /**
   * When defined, the item renders as a checkable toggle with a leading
   * `✓` (checked) or blank gutter (unchecked) — used by the bottom-bar
   * visibility menu. `undefined` renders a plain action item (no gutter).
   */
  checked?: boolean;
  /**
   * Whether selecting the item dismisses the menu. Defaults to `true`
   * (the action-item contract). Pass `false` for a checkable toggle so the
   * menu stays open and the user can flip several items in one pass.
   */
  closeOnSelect?: boolean;
  /**
   * When present, the item opens a SUBMENU of these instead of acting, and its
   * own `onSelect` is never called (pass a no-op).
   *
   * The submenu is another `ContextMenu`, so it inherits the viewport clamping,
   * the keyboard cycle and the dismissal discipline rather than reimplementing
   * three of them. One level is all any caller needs today; deeper nesting
   * already works, because the child is the same component.
   *
   * Selecting a child runs the child's action and then closes THIS menu too. A
   * format picked under "Export…" must not leave the parent standing over the
   * save dialog it just opened.
   */
  children?: ContextMenuItem[];
  /** Called when the item is selected. Ignored when `children` is present. */
  onSelect: () => void;
};

export type ContextMenuProps = {
  /** Anchor position in client (viewport) coordinates. */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Render a filter box pinned at the top and match items by label — for a long
   *  list like the "Move to…" folder tree of a deep vault (#205). Default off, so
   *  short menus (rename / delete) are unchanged. */
  searchable?: boolean;
  /** Placeholder for the filter box (only when `searchable`). */
  searchPlaceholder?: string;
  /**
   * Whether to move DOM focus into this menu on mount. Default `true`, which is
   * what makes a menu opened by right-click or by Enter keyboard-operable from
   * the start.
   *
   * A submenu opened by HOVER passes `false`: the pointer is driving, the user
   * has not asked for focus, and taking it strands the keyboard cycle when the
   * pointer moves on. Opened by CLICK it passes `true`, because then the user
   * did ask.
   */
  autoFocus?: boolean;
  /**
   * Accessible name for the `role="menu"`. A submenu is given its parent row's
   * label, which is how a screen reader says which menu the focus just entered.
   * `NoteActionsMenu` names its submenu the same way; the two implementations
   * had drifted apart on this, and on the chevron below.
   */
  label?: string;
};

const MENU_STYLE: CSSProperties = {
  position: "fixed",
  zIndex: 1000,
  minWidth: 140,
  // Bound the height and scroll inside: a long menu — the "Move to…" folder
  // tree of a deep vault — otherwise runs off the bottom of the viewport with no
  // way to reach the folders past the edge (#205). Short menus (rename/delete)
  // never approach the cap, so they are unaffected. The edge-clamp below measures
  // the capped height, so positioning still keeps the whole menu on screen.
  maxHeight: "min(70vh, 560px)",
  overflowY: "auto",
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-1)",
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.12)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
};

const ITEM_STYLE_BASE: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "start",
  background: "transparent",
  border: 0,
  padding: "6px 10px",
  borderRadius: 4,
  cursor: "pointer",
  color: "var(--fg-1)",
  fontFamily: "inherit",
  fontSize: "inherit",
};

const ITEM_STYLE_DESTRUCTIVE: CSSProperties = {
  ...ITEM_STYLE_BASE,
  color: "var(--warning)",
};

const DIVIDER_STYLE: CSSProperties = {
  height: 1,
  background: "var(--line-1)",
  margin: "4px 6px",
  border: 0,
};

// The filter box at the top of the "Move to…" menu (#205). Deliberately NOT
// sticky — it scrolls with the list, so no list row can ever paint through it,
// and since typing filters the list short there is rarely anything to scroll
// past. Opaque `--paper` background top and bottom so it never reads as
// transparent against the rows.
const SEARCH_INPUT_STYLE: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  appearance: "none",
  WebkitAppearance: "none",
  border: 0,
  borderBottom: "1px solid var(--line-1)",
  background: "var(--paper)",
  outline: "none",
  fontFamily: "inherit",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  padding: "6px 10px",
  marginBottom: "var(--space-1)",
};

export function ContextMenu({
  x,
  y,
  items,
  onClose,
  searchable = false,
  searchPlaceholder,
  autoFocus = true,
  label,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({
    left: x,
    top: y,
  });
  const [hoverId, setHoverId] = useState<string | null>(null);
  // The open submenu's parent id, plus where to put it. Deliberately NOT
  // derived from `hoverId`: leaving the parent row is how the pointer REACHES
  // the submenu, so a hover-derived one would unmount itself on the way. It
  // closes when a different row is hovered, and with the menu.
  const [submenu, setSubmenu] = useState<{
    id: string;
    x: number;
    y: number;
    /** True when a click opened it, so the nested menu takes focus. Hover
     *  leaves it false. */
    focus: boolean;
  } | null>(null);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visibleItems =
    q === "" ? items : items.filter((it) => it.label.toLowerCase().includes(q));

  // Viewport-edge clamp: after first paint, measure the menu's actual
  // size and shift left/up if it would overflow the viewport.
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    let left = x;
    let top = y;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (left + rect.width > vw - 4) left = Math.max(4, vw - rect.width - 4);
    if (top + rect.height > vh - 4) top = Math.max(4, vh - rect.height - 4);
    setPosition({ left, top });
  }, [x, y]);

  /**
   * Dismiss whatever submenu is open, putting focus back where the user was.
   *
   * Every path that closes one goes through here. Hovering a sibling row used
   * to call `setSubmenu(null)` directly, which skipped the restore that lived
   * only in the child's `onClose`: a submenu opened by KEYBOARD holds focus, so
   * unmounting it that way left `document.activeElement` on `<body>`, and this
   * menu's arrow, Home and End handling is an `onKeyDown` on its own div, which
   * therefore stopped receiving anything. Open with Enter, move the mouse, and
   * the whole menu was keyboard-dead until it was dismissed.
   *
   * Focus is only taken back when the submenu HELD it. Restoring after a
   * hover-open would move the caret for a gesture the user made with a pointer.
   */
  const closeSubmenu = useCallback(() => {
    setSubmenu((open) => {
      if (open !== null && open.focus) {
        ref.current
          ?.querySelector<HTMLButtonElement>(`[data-item-id="${open.id}"]`)
          ?.focus();
      }
      return null;
    });
  }, []);

  // Esc + outside-click dismissal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // One level per press. Both this menu and its nested submenu register
        // their own document listener, so without this bail a single Escape ran
        // both and dismissed the whole menu when the user meant to back out of
        // the submenu. The comment on the submenu's `onClose` claimed the
        // correct behaviour while the code did the other thing, and the test
        // file's own header lists this as one of the three it exists to pin.
        if (submenu !== null) {
          // One level per press, and through the shared routine so the focus
          // restore is not a property of which path happened to close it.
          closeSubmenu();
          return;
        }
        e.preventDefault();
        onClose();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      const node = ref.current;
      if (node === null) return;
      if (!node.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose, submenu, closeSubmenu]);

  // A11y (review): a `role="menu"` must be keyboard-operable. Focus the first
  // item on open so arrow-key navigation (handled on the container below) has a
  // starting point; Enter/Space activate via the native <button> semantics.
  useEffect(() => {
    // A submenu opened by HOVER must not take focus. It did, and the cost was
    // the whole menu's keyboard operability: moving the pointer on to a sibling
    // row unmounted the submenu, focus fell to `<body>`, and the arrow-key
    // cycle (a handler on the menu div) then received nothing for the rest of
    // the menu's life. In a searchable menu the same hover pulled focus out of
    // the filter box mid-typing.
    if (!autoFocus) return;
    if (searchable) {
      inputRef.current?.focus();
    } else {
      ref.current
        ?.querySelector<HTMLButtonElement>('[role^="menuitem"]')
        ?.focus();
    }
  }, [searchable, autoFocus]);

  // Where a parent row's submenu goes. Off the MENU's right edge rather than
  // the row's, so every submenu opens on the same vertical line whatever the
  // label lengths; `y` is the row's own top, so the first child sits level with
  // its parent. The nested menu clamps itself back into the viewport from there.
  const submenuAnchor = useCallback(
    (id: string, itemEl: HTMLElement, focus: boolean) => {
      const menuRect = ref.current?.getBoundingClientRect();
      const itemRect = itemEl.getBoundingClientRect();
      return {
        id,
        x: (menuRect?.right ?? itemRect.right) + 2,
        y: itemRect.top - 4,
        focus,
      };
    },
    [],
  );

  const handleSelect = useCallback(
    (item: ContextMenuItem) => {
      // A parent row acts by opening its submenu, which the pointer handlers do
      // (they are the ones holding the geometry). It has no action of its own,
      // and this is also the search box's Enter path, where the first match may
      // well be a parent.
      if (item.children !== undefined) return;
      item.onSelect();
      // A checkable toggle (closeOnSelect === false) keeps the menu open so
      // the user can flip several items in one pass; an action item dismisses.
      if (item.closeOnSelect !== false) onClose();
    },
    [onClose],
  );

  return (
    <div
      ref={ref}
      style={{ ...MENU_STYLE, left: position.left, top: position.top }}
      role="menu"
      aria-label={label}
      onKeyDown={(e) => {
        const node = ref.current;
        if (node === null) return;
        // A submenu is a nested `ContextMenu` rendered INSIDE this one, so that
        // the outside-click check still counts it as part of this menu. Two
        // consequences, and the guards below are one each.
        //
        // Its keydown handler runs first and then bubbles here, so without the
        // bail one arrow press would move focus twice, once per menu. And its
        // rows are descendants of this node, so without the filter they would
        // join this menu's cycle.
        //
        // Both are scoped to a submenu OTHER than this instance's own subtree.
        // They were not, and since this is the same component the child
        // inherited them: every row it renders sits inside the `[data-submenu]`
        // wrapper, so the child's own bail fired on its own rows and its filter
        // stripped them, leaving `its.length === 0`. A click-opened submenu
        // takes focus, so the user landed in a menu where ArrowDown, ArrowUp,
        // Home and End all did nothing. Escape and Enter still worked, from a
        // document listener and native button semantics, which is what made it
        // easy to miss.
        const ownWrapper = (el: Element | null): Element | null =>
          el === null ? null : el.closest("[data-submenu]");
        const isBelowANestedMenu = (el: Element | null): boolean => {
          const wrapper = ownWrapper(el);
          // A wrapper this node CONTAINS belongs to a submenu of ours. One that
          // contains this node is our own, and its rows are ours to drive.
          return wrapper !== null && node.contains(wrapper);
        };
        if (isBelowANestedMenu(e.target as HTMLElement)) return;
        const its = Array.from(
          node.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'),
        ).filter((el) => !isBelowANestedMenu(el));
        if (its.length === 0) return;
        const cur = its.findIndex((el) => el === document.activeElement);
        let next: number;
        if (e.key === "ArrowDown") next = cur < 0 ? 0 : (cur + 1) % its.length;
        else if (e.key === "ArrowUp")
          next = cur < 0 ? its.length - 1 : (cur - 1 + its.length) % its.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = its.length - 1;
        else return;
        e.preventDefault();
        its[next]?.focus();
      }}
    >
      {searchable && (
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          data-testid="notes.context-menu-search"
          autoComplete="off"
          spellCheck={false}
          style={SEARCH_INPUT_STYLE}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter commits the first (top) match; Arrow keys fall through to the
            // container handler above, which moves focus into the list.
            if (e.key === "Enter") {
              e.preventDefault();
              const first = visibleItems[0];
              if (first !== undefined) handleSelect(first);
            }
          }}
        />
      )}
      {visibleItems.map((item, i) => {
        const isHovering = hoverId === item.id;
        const baseStyle = item.destructive
          ? ITEM_STYLE_DESTRUCTIVE
          : ITEM_STYLE_BASE;
        const hoverBg = item.destructive
          ? "var(--warning-soft)"
          : "var(--paper-3)";
        const style: CSSProperties = isHovering
          ? { ...baseStyle, background: hoverBg }
          : baseStyle;
        // Divider before an item that opens a new logical group.
        const showDivider = i > 0 && item.group !== visibleItems[i - 1]?.group;
        return (
          <Fragment key={item.id}>
            {showDivider && <div style={DIVIDER_STYLE} role="separator" />}
            <button
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={item.checked === undefined ? undefined : item.checked}
            aria-haspopup={item.children === undefined ? undefined : "menu"}
            aria-expanded={
              item.children === undefined ? undefined : submenu?.id === item.id
            }
            data-testid="notes.context-menu-item"
            data-item-id={item.id}
            data-checked={item.checked === undefined ? undefined : String(item.checked)}
            style={style}
            onMouseEnter={(e) => {
              setHoverId(item.id);
              // Hovering ANY row settles the submenu question: a parent opens
              // its own, and a plain row closes whatever was open. That is what
              // dismisses it without needing a leave handler on the submenu.
              if (item.children === undefined) {
                closeSubmenu();
              } else {
                setSubmenu(submenuAnchor(item.id, e.currentTarget, false));
              }
            }}
            onMouseLeave={() => setHoverId((h) => (h === item.id ? null : h))}
            onClick={(e) => {
              if (item.children !== undefined) {
                setSubmenu(submenuAnchor(item.id, e.currentTarget, true));
                return;
              }
              handleSelect(item);
            }}
          >
            {item.checked === undefined && item.children === undefined ? (
              item.label
            ) : (
              <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                {item.checked !== undefined && (
                  <span
                    aria-hidden="true"
                    style={{ width: 12, flexShrink: 0, textAlign: "center" }}
                  >
                    {item.checked ? "✓" : ""}
                  </span>
                )}
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.children !== undefined && (
                  <span aria-hidden="true" style={{ display: "flex" }}>
                    <Icon name="chevron-right" size={12} />
                  </span>
                )}
              </span>
            )}
            </button>
            {item.children !== undefined && submenu?.id === item.id && (
              // Rendered INSIDE this menu on purpose: the outside-click handler
              // asks `node.contains(target)`, so a submenu mounted anywhere else
              // would read as an outside click and close its own parent the
              // moment the pointer entered it. `data-submenu` is what the
              // keyboard handler above keys off.
              <div role="none" data-submenu="">
                <ContextMenu
                  x={submenu.x}
                  y={submenu.y}
                  // Esc or an outside click closes the SUBMENU only. Closing the
                  // parent here would swallow the click that opened a sibling
                  // row, because that click is "outside" the submenu too.
                  autoFocus={submenu.focus}
                  label={item.label}
                  onClose={closeSubmenu}
                  items={item.children.map((child) => ({
                    ...child,
                    onSelect: () => {
                      child.onSelect();
                      onClose();
                    },
                  }))}
                />
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
