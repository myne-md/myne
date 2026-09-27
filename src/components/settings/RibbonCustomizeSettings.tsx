// Settings → Appearance: left-ribbon customization (myne-md/myne#699).
//
// The heading row carries an "Add" button on its right; clicking it opens a
// dropdown (command-palette style: search field over the eligible commands that
// are not pinned yet). The list below shows only the PINNED commands,
// reorderable by drag, each with an × to remove. No checkboxes, no arrows.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { COMMAND_ACTIONS } from "../../commands";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { Input } from "../primitives/Input";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import { ERROR_STYLE } from "./panel-styles";
import { hoverSurface, HOVER_TRANSITION } from "../primitives/hoverSurface";
import { prefsRead, setRibbonItems, setRibbonVisible } from "../../lib/prefs";
import { resolveRibbonItems, ribbonEligibleIds } from "../../notes/ribbonItems";
import { CUSTOMIZE_LIST_STYLE, CustomizeRow, useDragReorder } from "./CustomizeList";

const SECTION_STYLE: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};
const ICON_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  border: 0,
  background: "transparent",
  color: "var(--fg-2)",
  cursor: "pointer",
  borderRadius: "var(--radius-1)",
  transition: HOVER_TRANSITION,
};
const DROPDOWN_STYLE: CSSProperties = {
  position: "absolute",
  top: "100%",
  insetInlineEnd: 0,
  zIndex: 10,
  width: 280,
  maxWidth: "100%",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  marginTop: "var(--space-1)",
  padding: "var(--space-2)",
  borderRadius: "var(--radius-2)",
  border: "1px solid var(--line-2)",
  background: "var(--bg-2)",
  boxShadow: "var(--shadow-2)",
};
const DROPDOWN_LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  maxHeight: 240,
  overflowY: "auto",
};
const CHOICE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-1)",
  border: 0,
  background: "transparent",
  color: "var(--fg-1)",
  cursor: "pointer",
  textAlign: "start",
  borderRadius: "var(--radius-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
};
const EMPTY_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
  margin: 0,
};

export function RibbonCustomizeSettings() {
  const { t } = useTranslation();
  const eligible = useMemo(() => ribbonEligibleIds(), []);
  const byId = useMemo(() => new Map(COMMAND_ACTIONS.map((a) => [a.id, a])), []);

  const [order, setOrder] = useState<string[]>([]);
  const [orderLoaded, setOrderLoaded] = useState(false);
  const [visible, setVisible] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        setOrder(resolveRibbonItems(p.ribbon_items, eligible));
        setVisible(p.ribbon_visible);
        setOrderLoaded(true);
      })
      .catch(() => {
        /* locked / no vault: leave defaults */
      });
    return () => {
      cancelled = true;
    };
  }, [eligible]);

  /**
   * Set when the picker closes by a route that owes focus back to the Add
   * button (Escape). Consumed by the effect below AFTER the close has
   * rendered, which is the part that cannot be done from the key handler.
   */
  const [restoreFocus, setRestoreFocus] = useState(false);

  useEffect(() => {
    if (!restoreFocus || pickerOpen) return;
    setRestoreFocus(false);
    // The Add button is a shared primitive with no ref forwarding; reach it by
    // its testid, which doubles as the stable selector. By now the picker is
    // gone and this node is the one that will survive.
    sectionRef.current
      ?.querySelector<HTMLButtonElement>(
        '[data-testid="settings.ribbon-customize.add"]',
      )
      ?.focus();
  }, [restoreFocus, pickerOpen]);

  // Click-away closes the dropdown. Escape closes it too and returns focus
  // to the Add button that opened it, so keyboard users are not dropped.
  useEffect(() => {
    if (!pickerOpen) return;
    function onDown(e: MouseEvent) {
      if (sectionRef.current !== null && !sectionRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Close, and ASK for focus back — do not take it here. Focusing
        // synchronously inside this handler races the re-render that
        // `setPickerOpen(false)` schedules: React tears the picker down
        // afterwards, and if reconciliation replaces the Add button's DOM node
        // the focus we just set goes with it and the keyboard user lands on
        // `<body>` with the panel behind them (myne-md/myne#775).
        //
        // It failed roughly one run in six under a loaded parallel suite, which
        // is exactly what a scheduling race looks like from the outside — and
        // on a slow machine it is not a test artefact, it is a keyboard user
        // being dropped. The effect below restores focus once the close has
        // actually rendered.
        setRestoreFocus(true);
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  function persistOrder(next: string[]) {
    const prev = order;
    setOrder(next);
    void setRibbonItems(next)
      .then(() => setError(null))
      .catch(() => {
        setOrder(prev);
        setError(t("settings.ribbonCustomize.errorSave"));
      });
  }
  function add(id: string) {
    persistOrder([...order, id]);
    setQuery("");
    setPickerOpen(false);
  }
  function remove(id: string) {
    persistOrder(order.filter((x) => x !== id));
  }

  function persistVisible(next: boolean) {
    setVisible(next);
    void setRibbonVisible(next)
      .then(() => setError(null))
      .catch(() => {
        setVisible(!next);
        setError(t("settings.ribbonCustomize.errorSave"));
      });
  }

  const reorder = useDragReorder(order, persistOrder);
  const pinned = new Set(order);
  const q = query.trim().toLowerCase();
  const choices = eligible.filter((id) => {
    if (pinned.has(id)) return false;
    if (q === "") return true;
    const a = byId.get(id);
    return (a?.label ?? "").toLowerCase().includes(q) || id.toLowerCase().includes(q);
  });

  return (
    <>
      <div ref={sectionRef} style={SECTION_STYLE}>
        <SettingRow
          anchorId="appearance.ribbon"
          testId="settings.ribbon-customize"
          label={t("settings.ribbonCustomize.label")}
          helper={t("settings.ribbonCustomize.helper")}
          control={
            <Button
              type="button"
              variant="secondary"
              onClick={() => setPickerOpen((v) => !v)}
              data-testid="settings.ribbon-customize.add"
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
            >
              {t("settings.ribbonCustomize.add")}
            </Button>
          }
        />
        {pickerOpen && (
          <div style={DROPDOWN_STYLE} data-testid="settings.ribbon-customize.picker">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.ribbonCustomize.searchPlaceholder")}
              aria-label={t("settings.ribbonCustomize.searchPlaceholder")}
              autoFocus
              data-testid="settings.ribbon-customize.search"
            />
            <div
              style={DROPDOWN_LIST_STYLE}
              role="listbox"
              // Named (myne#728, task 4): the only unnamed listbox left in the
              // tree. The input above it is named; the list of results was not,
              // and the input's name does not carry down to it.
              aria-label={t("settings.ribbonCustomize.searchResultsLabel")}
            >
              {choices.map((id) => {
                const action = byId.get(id);
                if (action === undefined) return null;
                return (
                  <button
                    key={id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => add(id)}
                    {...hoverSurface()}
                    style={CHOICE_STYLE}
                    data-testid="settings.ribbon-customize.choice"
                    data-item-id={id}
                  >
                    <Icon name={action.ribbon!.icon} size={16} />
                    {action.label}
                  </button>
                );
              })}
              {choices.length === 0 && <p style={EMPTY_STYLE}>{t("settings.ribbonCustomize.searchEmpty")}</p>}
            </div>
          </div>
        )}
      </div>
      <div
        style={CUSTOMIZE_LIST_STYLE}
        role="list"
        data-testid="settings.ribbon-customize.list"
      >
        {orderLoaded && order.length === 0 && (
          <p style={EMPTY_STYLE}>{t("settings.ribbonCustomize.empty")}</p>
        )}
        {order.map((id, index) => {
          const action = byId.get(id);
          if (action === undefined) return null;
          return (
            <CustomizeRow
              key={id}
              id={id}
              icon={action.ribbon!.icon}
              label={action.label}
              index={index}
              total={order.length}
              reorder={reorder}
              testId="settings.ribbon-customize.row"
              trailing={
                <button
                  type="button"
                  aria-label={t("settings.ribbonCustomize.remove", { name: action.label })}
                  onClick={() => remove(id)}
                  {...hoverSurface()}
                  style={ICON_BUTTON_STYLE}
                  data-testid="settings.ribbon-customize.remove"
                  data-item-id={id}
                >
                  <Icon name="x" size={16} />
                </button>
              }
            />
          );
        })}
      </div>
      <SettingRow
        anchorId="appearance.ribbon-visible"
        label={t("settings.ribbonCustomize.showLabel")}
        helper={t("settings.ribbonCustomize.showHelper")}
        control={
          <Switch
            checked={visible}
            onChange={(v) => persistVisible(v)}
            ariaLabel={t("settings.ribbonCustomize.showLabel")}
            testId="settings.ribbon-customize.show"
          />
        }
      />
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
