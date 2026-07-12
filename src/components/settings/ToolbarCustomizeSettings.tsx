// Settings → Editor: floating-toolbar customization (MYND-336). A reorder +
// show/hide list over the FROZEN toolbar command vocabulary (no custom buttons).
// Self-contained like its sibling controls (LineNumbersSettings): local state
// loaded on mount, disk-first persist via the vault.prefs setters. The resolved
// order/hidden is what the editor's toolbar plugin renders (the plugin wiring is
// a follow-up; this owns the config surface + persistence). The slash-menu twin
// list is a follow-up (same shape, its own vocabulary).

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ControlBlock } from "./ControlBlock";
import { prefsRead, setEditorToolbarHidden, setEditorToolbarOrder } from "../../lib/prefs";
import { resolveBarOrder } from "../../notes/barItemsOrder";
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
  padding: "4px 8px",
  borderRadius: "var(--radius-1)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--fg-1)",
};
const ITEM_LABEL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  cursor: "pointer",
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

  return (
    <>
      <ControlBlock
        label={t("settings.toolbarCustomize.label")}
        helper={t("settings.toolbarCustomize.helper")}
        control={
          <div data-testid="settings.toolbar-customize" style={LIST_STYLE}>
            {fullOrder.map((id, i) => (
              <div key={id} style={ROW_STYLE}>
                <label style={ITEM_LABEL_STYLE}>
                  <input
                    type="checkbox"
                    checked={!hiddenSet.has(id)}
                    onChange={() => toggleShown(id)}
                    data-testid="settings.toolbar-customize.toggle"
                    data-item-id={id}
                  />
                  {t(toolbarItemLabelKey(id) ?? id)}
                </label>
                <span>
                  <button
                    type="button"
                    aria-label={t("settings.toolbarCustomize.moveUp")}
                    disabled={i === 0}
                    onClick={() => move(id, -1)}
                    style={ARROW_STYLE}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={t("settings.toolbarCustomize.moveDown")}
                    disabled={i === fullOrder.length - 1}
                    onClick={() => move(id, 1)}
                    style={ARROW_STYLE}
                  >
                    ↓
                  </button>
                </span>
              </div>
            ))}
          </div>
        }
      />
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
