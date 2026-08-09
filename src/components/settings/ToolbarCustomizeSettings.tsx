// Settings → Editor: floating-toolbar customization (MYND-336). A reorder +
// show/hide list over the FROZEN toolbar command vocabulary (no custom buttons).
// Self-contained like its sibling controls (LineNumbersSettings): local state
// loaded on mount, disk-first persist via the vault.prefs setters. The resolved
// order/hidden is what the editor's toolbar plugin renders (the plugin wiring is
// a follow-up; this owns the config surface + persistence). The slash-menu twin
// list is a follow-up (same shape, its own vocabulary).

import { useEffect, useState, type CSSProperties, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { ControlBlock } from "./ControlBlock";
import { ERROR_STYLE } from "./panel-styles";
import { Icon } from "../primitives/Icon";
import {
  hoverSurface,
  HOVER_TRANSITION,
} from "../primitives/hoverSurface";
import { prefsRead, setEditorToolbarHidden, setEditorToolbarOrder } from "../../lib/prefs";
import { resolveBarOrder, reorderByDrop } from "../../notes/barItemsOrder";
import {
  EDITOR_TOOLBAR_DEFAULT_ORDER,
  EDITOR_TOOLBAR_PENDING_IDS,
  resolveToolbarHidden,
  toolbarItemLabelKey,
} from "../../notes/toolbarItems";

// Ids the floating toolbar cannot render yet (MYND-336 follow-up): pinned
// hidden, so their rows are visibly disabled and non-toggleable.
const PENDING_SET = new Set(EDITOR_TOOLBAR_PENDING_IDS);

const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 240,
};
const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2)",
  padding: "5px 8px",
  borderRadius: "var(--radius-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
};
// Drop indicator drawn as an inset accent bar via boxShadow — unlike a border it
// doesn't add to the box size, so rows never reflow when it appears and there is
// no partial-transparent-border artifact (WKWebView renders a 2px transparent
// top/bottom border on a rounded dark row as a light line — QA screenshot).
const DROP_BEFORE_STYLE: CSSProperties = {
  boxShadow: "inset 0 2px 0 0 var(--accent)",
  background: "var(--accent-soft)",
};
const DROP_AFTER_STYLE: CSSProperties = {
  boxShadow: "inset 0 -2px 0 0 var(--accent)",
  background: "var(--accent-soft)",
};
const GRIP_STYLE: CSSProperties = {
  cursor: "grab",
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
  lineHeight: 1,
  userSelect: "none",
  padding: "0 2px",
};
const ITEM_LABEL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  cursor: "pointer",
  flex: 1,
  minWidth: 0,
};
// A pinned (not-yet-renderable) row keeps its real label, dimmed + inert.
const ITEM_LABEL_PENDING_STYLE: CSSProperties = {
  ...ITEM_LABEL_STYLE,
  cursor: "default",
  color: "var(--fg-3)",
};
const PENDING_HINT_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  flexShrink: 0,
};
// The native checkbox is kept for behaviour + a11y + the E2E testid, but visually
// hidden (absolute, opacity 0) over a custom box so the CHECK MARK colour is
// ours: `--accent` fill + an `--accent-on` tick. `--accent-on` is black on a
// light accent and white on a dark one, so the tick stays readable at any accent
// (the OS checkbox drew a fixed near-white tick that vanished on a light accent).
const HIDDEN_INPUT_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  margin: 0,
  opacity: 0,
  cursor: "pointer",
};

function checkboxBoxStyle(checked: boolean, disabled: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 16,
    height: 16,
    flexShrink: 0,
    boxSizing: "border-box",
    borderRadius: "var(--radius-1)",
    border: `1px solid ${checked ? "var(--accent)" : "var(--line-2)"}`,
    background: checked ? "var(--accent)" : "transparent",
    color: "var(--accent-on)",
    opacity: disabled ? 0.5 : 1,
    transition:
      "background var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)",
  };
}
const ARROW_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--fg-2)",
  cursor: "pointer",
  padding: "0 4px",
  fontSize: "var(--text-base)",
  lineHeight: 1,
  borderRadius: "var(--radius-1)",
  transition: HOVER_TRANSITION,
};
const ARROW_DISABLED_STYLE: CSSProperties = {
  ...ARROW_STYLE,
  color: "var(--fg-3)",
  opacity: 0.35,
  cursor: "default",
};
export function ToolbarCustomizeSettings() {
  const { t } = useTranslation();
  const [order, setOrder] = useState<string[]>([...EDITOR_TOOLBAR_DEFAULT_ORDER]);
  const [hidden, setHidden] = useState<string[]>(resolveToolbarHidden([]));
  const [error, setError] = useState<string | null>(null);
  // Drag-to-reorder transient state: the id being dragged + the current drop
  // target (row id + which edge the drop indicator paints on).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; edge: "before" | "after" } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        setOrder(
          p.editor_toolbar_order.length > 0
            ? p.editor_toolbar_order
            : [...EDITOR_TOOLBAR_DEFAULT_ORDER],
        );
        setHidden(resolveToolbarHidden(p.editor_toolbar_hidden));
      })
      .catch(() => {
        /* locked / no vault — leave defaults */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Completed order (all vocabulary ids, self-healed against the canonical set).
  const fullOrder = resolveBarOrder(order, EDITOR_TOOLBAR_DEFAULT_ORDER);
  const hiddenSet = new Set(hidden);

  // Optimistic persist with rollback: the list updates immediately, but an IPC
  // failure restores the on-disk state so the UI never shows a layout that
  // didn't save.
  async function persistOrder(next: string[]) {
    const prev = order;
    setOrder(next);
    try {
      await setEditorToolbarOrder(next);
      setError(null);
    } catch {
      setOrder(prev);
      setError(t("settings.toolbarCustomize.errorSave"));
    }
  }
  async function persistHidden(next: string[]) {
    const prev = hidden;
    setHidden(next);
    try {
      await setEditorToolbarHidden(next);
      setError(null);
    } catch {
      setHidden(prev);
      setError(t("settings.toolbarCustomize.errorSave"));
    }
  }
  function toggleShown(id: string) {
    if (PENDING_SET.has(id)) return; // pinned hidden — non-toggleable
    void persistHidden(hiddenSet.has(id) ? hidden.filter((h) => h !== id) : [...hidden, id]);
  }
  function move(id: string, delta: number) {
    const idx = fullOrder.indexOf(id);
    const to = idx + delta;
    if (to < 0 || to >= fullOrder.length) return;
    const next = [...fullOrder];
    [next[idx], next[to]] = [next[to]!, next[idx]!];
    void persistOrder(next);
  }
  function onDragOver(e: DragEvent, id: string) {
    if (dragId === null || dragId === id) return;
    e.preventDefault(); // allow the drop
    const rect = e.currentTarget.getBoundingClientRect();
    const edge = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setDropAt({ id, edge });
  }
  function onDrop(id: string) {
    if (dragId !== null && dragId !== id && dropAt !== null) {
      void persistOrder(reorderByDrop(fullOrder, dragId, dropAt.id, dropAt.edge));
    }
    setDragId(null);
    setDropAt(null);
  }

  return (
    <>
      <ControlBlock
        label={t("settings.toolbarCustomize.label")}
        helper={t("settings.toolbarCustomize.helper")}
        control={
          <div data-testid="settings.toolbar-customize" style={LIST_STYLE}>
            {fullOrder.map((id, i) => {
              const dropStyle =
                dropAt?.id === id
                  ? dropAt.edge === "before"
                    ? DROP_BEFORE_STYLE
                    : DROP_AFTER_STYLE
                  : null;
              const isFirst = i === 0;
              const isLast = i === fullOrder.length - 1;
              const isPending = PENDING_SET.has(id);
              return (
                <div
                  key={id}
                  style={{ ...ROW_STYLE, ...dropStyle, opacity: dragId === id ? 0.4 : 1 }}
                  draggable
                  onDragStart={() => setDragId(id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropAt(null);
                  }}
                  onDragOver={(e) => onDragOver(e, id)}
                  onDrop={() => onDrop(id)}
                  data-item-id={id}
                >
                  <label style={isPending ? ITEM_LABEL_PENDING_STYLE : ITEM_LABEL_STYLE}>
                    <span style={GRIP_STYLE} aria-hidden="true">
                      ⠿
                    </span>
                    <span
                      style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}
                    >
                      <input
                        type="checkbox"
                        checked={!hiddenSet.has(id)}
                        onChange={() => toggleShown(id)}
                        disabled={isPending}
                        style={HIDDEN_INPUT_STYLE}
                        data-testid="settings.toolbar-customize.toggle"
                        data-item-id={id}
                      />
                      <span
                        aria-hidden="true"
                        style={checkboxBoxStyle(!hiddenSet.has(id), isPending)}
                      >
                        {!hiddenSet.has(id) && (
                          <Icon name="check" size={12} strokeWidth={3} />
                        )}
                      </span>
                    </span>
                    {t(toolbarItemLabelKey(id) ?? id)}
                    {isPending && (
                      <span style={PENDING_HINT_STYLE}>
                        {t("settings.toolbarCustomize.pendingHint")}
                      </span>
                    )}
                  </label>
                  <span>
                    <button
                      type="button"
                      aria-label={t("settings.toolbarCustomize.moveUp")}
                      disabled={isFirst}
                      onClick={() => move(id, -1)}
                      {...hoverSurface({ disabled: isFirst })}
                      style={isFirst ? ARROW_DISABLED_STYLE : ARROW_STYLE}
                      data-testid="settings.toolbar-customize.move-up"
                      data-item-id={id}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={t("settings.toolbarCustomize.moveDown")}
                      disabled={isLast}
                      onClick={() => move(id, 1)}
                      {...hoverSurface({ disabled: isLast })}
                      style={isLast ? ARROW_DISABLED_STYLE : ARROW_STYLE}
                      data-testid="settings.toolbar-customize.move-down"
                      data-item-id={id}
                    >
                      ↓
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        }
      />
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
