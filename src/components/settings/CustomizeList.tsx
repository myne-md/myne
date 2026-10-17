// The shared shape of a "customize this strip of commands" list in Settings
// (myne-md/myne#773).
//
// Two settings answer the same question about two strips of the same app — the
// left ribbon and the bottom bar — and they answered it in two different
// shapes: the ribbon a drag-reorderable roster of icon rows, the bar a flat
// column of switches with no icons, no order and no handles. Nothing about
// either strip justifies the difference. A user who has customized one arrives
// at the other and has to work out what happened to the affordance they just
// learned.
//
// So the row is ONE component with a trailing slot, not two lists that look
// alike. The difference between them is real but small — the ribbon removes a
// command with an ×, the bar hides one with a switch — and it lives in that
// slot. Everything the two share (the grip, the icon, the label, the drop
// indicator, the Alt+Arrow keyboard fallback, the drag bookkeeping) is here,
// which is the only arrangement in which "they look the same" stays true after
// the next change to either.

import { useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../primitives/Icon";
import type { IconName } from "../../lib/icons";
import { moveBarItem, reorderByDrop } from "../../notes/barItemsOrder";

export const CUSTOMIZE_LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};

const ROW_STYLE: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-1) var(--space-2)",
  borderRadius: "var(--radius-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
};
const GRIP_STYLE: CSSProperties = {
  cursor: "grab",
  color: "var(--fg-3)",
  lineHeight: 1,
  userSelect: "none",
  fontSize: "var(--text-sm)",
};
const LABEL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flex: 1,
  minWidth: 0,
};

export interface DragReorder {
  dragId: string | null;
  dropAt: { id: string; edge: "before" | "after" } | null;
  /** Spread onto a row. Owns every drag listener the gesture needs. */
  rowDragProps: (id: string) => {
    draggable: true;
    onDragStart: () => void;
    onDragEnd: () => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: () => void;
  };
  /** Alt+↑ / Alt+↓, the keyboard fallback for the same reorder. */
  onRowKeyDown: (e: React.KeyboardEvent, id: string) => void;
}

/**
 * The drag bookkeeping, held once.
 *
 * `persist` receives the whole new order and owns the write, because the two
 * callers persist to different prefs keys and the optimistic-then-rollback
 * shape differs between them.
 */
export function useDragReorder(
  order: readonly string[],
  persist: (next: string[]) => void,
): DragReorder {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; edge: "before" | "after" } | null>(
    null,
  );

  return {
    dragId,
    dropAt,
    rowDragProps: (id: string) => ({
      draggable: true,
      onDragStart: () => setDragId(id),
      onDragEnd: () => {
        setDragId(null);
        setDropAt(null);
      },
      onDragOver: (e: DragEvent) => {
        if (dragId === null || dragId === id) return;
        // Without `preventDefault` the drop is refused and the gesture ends
        // with the row snapping back, which reads as the list rejecting a
        // perfectly good drag.
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        setDropAt({
          id,
          edge: e.clientY < rect.top + rect.height / 2 ? "before" : "after",
        });
      },
      onDrop: () => {
        if (dragId !== null && dragId !== id && dropAt !== null) {
          persist(reorderByDrop(order, dragId, dropAt.id, dropAt.edge));
        }
        setDragId(null);
        setDropAt(null);
      },
    }),
    onRowKeyDown: (e: React.KeyboardEvent, id: string) => {
      // The rail's own Alt+Arrow contract (LeftRibbon.tsx). The roster lists
      // the whole order, so the full order is both sequences `moveBarItem`
      // takes. A pointer-only reorder is a reorder some users cannot perform.
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      persist(moveBarItem(order, order, id, e.key === "ArrowUp" ? -1 : 1));
    },
  };
}

export function CustomizeRow({
  id,
  icon,
  label,
  note,
  index,
  total,
  reorder,
  trailing,
  testId,
}: {
  id: string;
  /**
   * Omitted by the floating-toolbar list, whose frozen vocabulary carries no
   * icons (MYND-336) — so the row renders the label without one. The ribbon and
   * the bottom bar both pass one. A THIRD adopter without icons needed this slot
   * to be optional, which is the shape a shared row is supposed to have: the
   * difference between the three is real and lives in props, not in a fourth copy.
   */
  icon?: IconName;
  label: string;
  /**
   * A trailing remark rendered after the label, still inside the labelled area:
   * the toolbar's "not yet renderable" hint. Deliberately not part of `label`,
   * which is a translated string rather than a node.
   */
  note?: ReactNode;
  index: number;
  total: number;
  reorder: DragReorder;
  /** The per-row operation that differs: the ribbon's ×, the bar's switch, the
   *  toolbar's show/hide box. */
  trailing: ReactNode;
  testId: string;
}) {
  const { t } = useTranslation();
  const dropEdge = reorder.dropAt?.id === id ? reorder.dropAt.edge : null;
  return (
    <div
      style={{ ...ROW_STYLE, opacity: reorder.dragId === id ? 0.4 : 1 }}
      tabIndex={0}
      role="listitem"
      aria-label={t("settings.ribbonCustomize.position", {
        name: label,
        index: index + 1,
        total,
      })}
      onKeyDown={(e) => reorder.onRowKeyDown(e, id)}
      {...reorder.rowDragProps(id)}
      data-testid={testId}
      data-item-id={id}
    >
      {/* The drop indicator, which both lists used to render as an empty span
          with `style={undefined}` — an element that draws nothing, so the drag
          had no target feedback at all and the user found out where the row
          landed by dropping it. `.myne-drop-line` is the shared one, and it
          survives forced colours, which an accent-coloured div does not. */}
      {dropEdge !== null && (
        <span aria-hidden="true" className="myne-drop-line" data-edge={dropEdge} />
      )}
      <span style={GRIP_STYLE} aria-hidden="true">
        ⠿
      </span>
      <span style={LABEL_STYLE}>
        {icon !== undefined && <Icon name={icon} size={16} />}
        {label}
        {note}
      </span>
      {trailing}
    </div>
  );
}
