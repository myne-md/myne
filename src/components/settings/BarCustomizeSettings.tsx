// Settings → Appearance: bottom-bar customization (myne-md/myne#773).
//
// A show/hide list over the frozen bottom-bar vocabulary (`BAR_ITEMS`), the
// third reader of that one roster alongside the bar itself and the bar's
// right-click menu.
//
// This block is a PRECONDITION of the bar being allowed to disappear, not a
// convenience beside it. Until it existed, `setHiddenBarItems` had exactly two
// call sites and both were inside the bar's own context menu — so once the bar
// hid its last item and vanished, the only UI that could bring anything back
// vanished with it, and the setting became unrecoverable from the surface that
// set it. A control that can be turned off and not back on is a bug, so the
// early return in `BottomBar` and this list are one change.
//
// Reorder deliberately stays on the bar's right-click menu. Ordering is a
// direct-manipulation question best answered next to the thing being ordered,
// and duplicating it here would be a second place for it to drift — which is
// exactly what the roster move was about. Visibility is different: it is the
// one operation whose own surface can disappear.

// Self-contained like its siblings (`RibbonCustomizeSettings`,
// `ToolbarCustomizeSettings`): local state loaded on mount, disk-first persist
// through the `vault.prefs` setters. Deliberately NOT the `usePrefs` hook —
// the Settings panels are rendered in tests without that provider, and reaching
// for it here took the whole Appearance panel down rather than just this block.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BAR_ITEMS } from "../../notes/barItemsOrder";
import { ControlBlock } from "./ControlBlock";
import { SettingRow } from "./SettingRow";
import { Switch } from "../primitives/Switch";
import { prefsRead, setHiddenBarItems } from "../../lib/prefs";

export function BarCustomizeSettings() {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState<readonly string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        // `?? []` is not defensive noise: a partially-mocked `prefsRead` (and a
        // vault written before this key existed) yields `undefined` here, and an
        // undefined `hidden` throws on `.includes` during the NEXT render — past
        // the `.catch` below, which only sees the promise. That took the whole
        // Appearance panel blank rather than this one block.
        setHidden(p.hidden_bar_items ?? []);
      })
      .catch(() => {
        /* locked / no vault: leave every item shown, which is the default */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ControlBlock
      label={t("settings.appearance.barCustomize.label")}
      helper={t("settings.appearance.barCustomize.helper")}
      anchorId="appearance.bar-customize"
      testId="settings.bar-customize"
      control={
        <div style={{ display: "flex", flexDirection: "column" }}>
          {BAR_ITEMS.map((item) => {
            const shown = !hidden.includes(item.id);
            return (
              <SettingRow
                key={item.id}
                label={t(item.labelKey)}
                testId={`settings.bar-item.${item.id}`}
                control={(describedBy) => (
                  <Switch
                    checked={shown}
                    ariaLabel={t(item.labelKey)}
                    ariaDescribedBy={describedBy}
                    testId={`settings.bar-item-toggle.${item.id}`}
                    onChange={(next) => {
                      const updated = next
                        ? hidden.filter((x) => x !== item.id)
                        : [...hidden, item.id];
                      // Optimistic, then persist. The bar reads the same pref
                      // through the cross-surface prefs nonce, so a failed write
                      // converges on the next read rather than leaving the two
                      // surfaces disagreeing.
                      setHidden(updated);
                      void setHiddenBarItems([...updated]).catch(() => {
                        setHidden(hidden);
                      });
                    }}
                  />
                )}
              />
            );
          })}
        </div>
      }
    />
  );
}
