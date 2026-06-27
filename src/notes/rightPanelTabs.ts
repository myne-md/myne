// Right-panel tab vocabulary + active-tab self-heal (right-panel tabs).
//
// The right sidebar is a multi-tab panel modeled on the bottom bar: multiple
// non-closable tabs, drag-reorderable, individually hideable via right-click,
// with ONE active tab at a time. This module is the closed tab vocabulary (the
// single source for the restore checklist) plus the active-tab resolver. The
// order/reorder/hide math is REUSED directly from `barItemsOrder.ts`
// (`resolveBarOrder` / `reorderByDrop` / `canMoveBarItem` / `moveBarItem`) — no
// fork. Persisted via `setRightPanelActiveTab` / `setRightPanelHiddenTabs` /
// `setRightPanelTabOrder` (src/lib/prefs.ts).

import type { IconName } from "../lib/icons";

/** One right-panel tab: its stable id, its i18n label key, and its strip icon. */
export interface RightPanelTab {
  readonly id: string;
  readonly labelKey: string;
  readonly icon: IconName;
}

/**
 * The closed tab vocabulary — the single source of truth for the strip-wide
 * right-click restore checklist (and the order resolver's canonical set). Adding
 * a tab means appending it here AND to {@link RIGHT_PANEL_DEFAULT_ORDER}.
 */
export const RIGHT_PANEL_TABS: readonly RightPanelTab[] = [
  { id: "backlinks", labelKey: "editor.chrome.rightPanel.tabs.backlinks", icon: "link" },
  { id: "unlinked", labelKey: "editor.chrome.rightPanel.tabs.unlinked", icon: "hash" },
  { id: "outline", labelKey: "editor.chrome.rightPanel.tabs.outline", icon: "list" },
];

/**
 * Canonical default display order — matches the pre-feature render intent
 * (Backlinks first). A known id absent from a user's stored order falls back to
 * its position here (see `resolveBarOrder`). Must list every id in
 * {@link RIGHT_PANEL_TABS}.
 */
export const RIGHT_PANEL_DEFAULT_ORDER: readonly string[] = ["backlinks", "unlinked", "outline"];

/** Label-key lookup for a tab id (used by the strip + the context menus). */
export function rightPanelTabLabelKey(id: string): string | null {
  return RIGHT_PANEL_TABS.find((t) => t.id === id)?.labelKey ?? null;
}

/**
 * Resolve the EFFECTIVE active tab from the stored pointer, the resolved tab
 * order, and the hidden set. Self-healing (the `active_workspace` precedent):
 * - if `stored` is a known, visible tab → keep it;
 * - else fall back to the FIRST visible tab in `order`;
 * - else (every tab hidden) → `null` (the panel shows its all-hidden empty state).
 *
 * Healed-on-read: a stored pointer to a now-hidden/unknown tab is NOT rewritten
 * to disk; it is simply reinterpreted each render (the tolerant-`resolveBarOrder`
 * philosophy). `order` should already be a permutation of the canonical set
 * (pass `resolveBarOrder(stored, RIGHT_PANEL_DEFAULT_ORDER)`).
 */
export function resolveActiveTab(
  stored: string | null,
  order: readonly string[],
  hidden: readonly string[],
): string | null {
  const hiddenSet = new Set(hidden);
  const visible = order.filter((id) => !hiddenSet.has(id));
  if (visible.length === 0) return null;
  if (stored !== null && visible.includes(stored)) return stored;
  return visible[0]!;
}
