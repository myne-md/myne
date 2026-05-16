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
  /** Optional `var(--*)` color override for destructive items. */
  destructive?: boolean;
  /** Called when the item is selected. ContextMenu closes regardless. */
  onSelect: () => void;
};

export type ContextMenuProps = {
  /** Anchor position in client (viewport) coordinates. */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
};

const MENU_STYLE: CSSProperties = {
  position: "fixed",
  zIndex: 1000,
  minWidth: 140,
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

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({
    left: x,
    top: y,
  });
  const [hoverId, setHoverId] = useState<string | null>(null);

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

  const handleSelect = useCallback(
    (item: ContextMenuItem) => {
      item.onSelect();
      onClose();
    },
    [onClose],
  );

  return (
    <div
      ref={ref}
      style={{ ...MENU_STYLE, left: position.left, top: position.top }}
      role="menu"
    >
      {items.map((item) => {
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
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            data-item-id={item.id}
            style={style}
            onMouseEnter={() => setHoverId(item.id)}
            onMouseLeave={() => setHoverId((h) => (h === item.id ? null : h))}
            onClick={() => handleSelect(item)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
