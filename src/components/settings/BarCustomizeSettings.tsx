// Settings → Appearance: bottom-bar customization (myne-md/myne#773).
//
// A reorderable, show/hide roster over the frozen bottom-bar vocabulary
// (`BAR_ITEMS`), the third reader of that one roster alongside the bar itself
// and the bar's right-click menu.
//
// This block is a PRECONDITION of the bar being allowed to disappear, not a
// convenience beside it. Until it existed, `setHiddenBarItems` had exactly two
// call sites and both were inside the bar's own context menu — so once the bar
// hid its last item and vanished, the only UI that could bring anything back
// vanished with it, and the setting became unrecoverable from the surface that
// set it. A control that can be turned off and not back on is a bug, so the
// early return in `BottomBar` and this list are one change.
//
// ── Reorder lives here too now ─────────────────────────────────────────────
// It did not at first, and the argument for keeping it out was that ordering
// is a direct-manipulation question best answered next to the thing being
// ordered, with the bar's right-click menu as that place. What that reasoning
// missed is that the left ribbon — the same kind of strip, one screen edge
// away — has always answered it in Settings, with a drag-reorderable roster of
// icon rows, while this one was a flat column of switches. So the two settings
// for the two strips did not look like the same idea, and a user who learned
// one arrived at the other and found the affordance gone. Sharing
// `CustomizeList` is what keeps that fixed: the row is one component, and the
// only thing this list supplies of its own is what its trailing slot holds.
//
// The bar's right-click reorder stays where it is. It is not a duplicate of
// this so much as the in-place gesture, and both write the same pref.

// Self-contained like its siblings (`RibbonCustomizeSettings`,
// `ToolbarCustomizeSettings`): local state loaded on mount, disk-first persist
// through the `vault.prefs` setters. Deliberately NOT the `usePrefs` hook —
// the Settings panels are rendered in tests without that provider, and reaching
// for it here took the whole Appearance panel down rather than just this block.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BAR_ITEMS,
  RIGHT_CLUSTER_DEFAULT_ORDER,
  resolveBarOrder,
} from "../../notes/barItemsOrder";
import { ControlBlock } from "./ControlBlock";
import { CUSTOMIZE_LIST_STYLE, CustomizeRow, useDragReorder } from "./CustomizeList";
import { Switch } from "../primitives/Switch";
import { prefsRead, setBarItemsOrder, setHiddenBarItems } from "../../lib/prefs";

export function BarCustomizeSettings() {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState<readonly string[]>([]);
  // The bar's DISPLAY order, which is the order this list must show. Rendering
  // `BAR_ITEMS` instead would be rendering menu order — a different sequence of
  // the same nine ids — so a reordered bar and its own settings list would
  // disagree about where an item is, on the one surface that exists to move it.
  const [order, setOrder] = useState<string[]>([...RIGHT_CLUSTER_DEFAULT_ORDER]);

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
        setOrder(resolveBarOrder(p.bar_items_order ?? []));
      })
      .catch(() => {
        /* locked / no vault: leave every item shown, in default order */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function persistOrder(next: string[]) {
    const prev = order;
    setOrder(next);
    // Optimistic, then persist — the bar reads the same pref through the
    // cross-surface prefs nonce, so a failed write converges on the next read
    // rather than leaving the two surfaces disagreeing.
    void setBarItemsOrder(next).catch(() => setOrder(prev));
  }

  const reorder = useDragReorder(order, persistOrder);
  const byId = new Map(BAR_ITEMS.map((i) => [i.id, i]));

  return (
    <ControlBlock
      label={t("settings.appearance.barCustomize.label")}
      helper={t("settings.appearance.barCustomize.helper")}
      anchorId="appearance.bar-customize"
      testId="settings.bar-customize"
      control={
        <div
          style={CUSTOMIZE_LIST_STYLE}
          role="list"
          data-testid="settings.bar-customize.list"
        >
          {order.map((id, index) => {
            const item = byId.get(id);
            // An id in the stored order that the roster no longer carries — a
            // bar item removed in a later release. `resolveBarOrder` already
            // drops unknown ids, so this is the belt to that braces.
            if (item === undefined) return null;
            const shown = !hidden.includes(id);
            return (
              <CustomizeRow
                key={id}
                id={id}
                icon={item.icon}
                label={t(item.labelKey)}
                index={index}
                total={order.length}
                reorder={reorder}
                testId={`settings.bar-item.${id}`}
                trailing={
                  <Switch
                    checked={shown}
                    ariaLabel={t(item.labelKey)}
                    testId={`settings.bar-item-toggle.${id}`}
                    onChange={(next) => {
                      const updated = next
                        ? hidden.filter((x) => x !== id)
                        : [...hidden, id];
                      setHidden(updated);
                      void setHiddenBarItems([...updated]).catch(() => {
                        setHidden(hidden);
                      });
                    }}
                  />
                }
              />
            );
          })}
        </div>
      }
    />
  );
}
