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
  /** Called when the item is selected. */
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
  borderRadius: 6,
  padding: 4,
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.12)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
};

const ITEM_STYLE_BASE: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
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
  fontSize: 13,
  color: "var(--fg-1)",
  padding: "6px 10px",
  marginBottom: 4,
};

export function ContextMenu({
  x,
  y,
  items,
  onClose,
  searchable = false,
  searchPlaceholder,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({
    left: x,
    top: y,
  });
  const [hoverId, setHoverId] = useState<string | null>(null);
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

  // Esc + outside-click dismissal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
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
  }, [onClose]);

  // A11y (review): a `role="menu"` must be keyboard-operable. Focus the first
  // item on open so arrow-key navigation (handled on the container below) has a
  // starting point; Enter/Space activate via the native <button> semantics.
  useEffect(() => {
    if (searchable) {
      inputRef.current?.focus();
    } else {
      ref.current
        ?.querySelector<HTMLButtonElement>('[role^="menuitem"]')
        ?.focus();
    }
  }, [searchable]);

  const handleSelect = useCallback(
    (item: ContextMenuItem) => {
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
      onKeyDown={(e) => {
        const node = ref.current;
        if (node === null) return;
        const its = Array.from(
          node.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'),
        );
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
            data-testid="notes.context-menu-item"
            data-item-id={item.id}
            data-checked={item.checked === undefined ? undefined : String(item.checked)}
            style={style}
            onMouseEnter={() => setHoverId(item.id)}
            onMouseLeave={() => setHoverId((h) => (h === item.id ? null : h))}
            onClick={() => handleSelect(item)}
          >
            {item.checked === undefined ? (
              item.label
            ) : (
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  aria-hidden="true"
                  style={{ width: 12, flexShrink: 0, textAlign: "center" }}
                >
                  {item.checked ? "✓" : ""}
                </span>
                {item.label}
              </span>
            )}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
