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
import { prefsRead, setEditorToolbarHidden, setEditorToolbarOrder } from "../../lib/prefs";
import { resolveBarOrder, reorderByDrop } from "../../notes/barItemsOrder";
import {
  EDITOR_TOOLBAR_DEFAULT_HIDDEN,
  EDITOR_TOOLBAR_DEFAULT_ORDER,
  toolbarItemLabelKey,
} from "../../notes/toolbarItems";

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
  gap: 8,
  padding: "5px 8px",
  borderRadius: "var(--radius-1)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
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
  fontSize: 13,
  lineHeight: 1,
  userSelect: "none",
  padding: "0 2px",
};
const ITEM_LABEL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  cursor: "pointer",
  flex: 1,
  minWidth: 0,
};
const CHECKBOX_STYLE: CSSProperties = {
  // Theme the control instead of the OS default (macOS system blue) so it
  // follows the active theme's accent (QA: the native blue was off-theme).
  accentColor: "var(--accent)",
};
const ARROW_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--fg-2)",
  cursor: "pointer",
  padding: "0 4px",
  fontSize: 14,
  lineHeight: 1,
};
const ARROW_DISABLED_STYLE: CSSProperties = {
  ...ARROW_STYLE,
  color: "var(--fg-3)",
  opacity: 0.35,
  cursor: "default",
};
const ERROR_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

export function ToolbarCustomizeSettings() {
  const { t } = useTranslation();
  const [order, setOrder] = useState<string[]>([...EDITOR_TOOLBAR_DEFAULT_ORDER]);
  const [hidden, setHidden] = useState<string[]>([...EDITOR_TOOLBAR_DEFAULT_HIDDEN]);
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
        setHidden(
          p.editor_toolbar_hidden.length > 0
            ? p.editor_toolbar_hidden
            : [...EDITOR_TOOLBAR_DEFAULT_HIDDEN],
        );
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

  async function persistOrder(next: string[]) {
    setOrder(next);
    try {
      await setEditorToolbarOrder(next);
      setError(null);
    } catch {
      setError(t("settings.toolbarCustomize.errorSave"));
    }
  }
  async function persistHidden(next: string[]) {
    setHidden(next);
    try {
      await setEditorToolbarHidden(next);
      setError(null);
    } catch {
      setError(t("settings.toolbarCustomize.errorSave"));
    }
  }
  function toggleShown(id: string) {
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
                  <label style={ITEM_LABEL_STYLE}>
                    <span style={GRIP_STYLE} aria-hidden="true">
                      ⠿
                    </span>
                    <input
                      type="checkbox"
                      checked={!hiddenSet.has(id)}
                      onChange={() => toggleShown(id)}
                      style={CHECKBOX_STYLE}
                      data-testid="settings.toolbar-customize.toggle"
                      data-item-id={id}
                    />
                    {t(toolbarItemLabelKey(id) ?? id)}
                  </label>
                  <span>
                    <button
                      type="button"
                      aria-label={t("settings.toolbarCustomize.moveUp")}
                      disabled={isFirst}
                      onClick={() => move(id, -1)}
                      style={isFirst ? ARROW_DISABLED_STYLE : ARROW_STYLE}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={t("settings.toolbarCustomize.moveDown")}
                      disabled={isLast}
                      onClick={() => move(id, 1)}
                      style={isLast ? ARROW_DISABLED_STYLE : ARROW_STYLE}
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
