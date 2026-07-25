// Shared grouping for the Settings search results (MYND-536). Both the results
// list (Task 3) and the keyboard navigation (Task 5) need the SAME ordering — a
// flat, best-match-ordered list AND a panel-grouped view whose flat traversal
// equals that list — so arrow-key movement and the rendered rows never disagree.

import type { SettingsIndexEntry } from "./settingsSearchIndex";
import type { PanelId } from "../../SettingsModal";

export interface ResultGroup {
  panelId: PanelId;
  entries: SettingsIndexEntry[];
}

/**
 * Group results by panel, preserving (a) the panel's first-appearance order in
 * the match list and (b) the match order within each panel. The concatenation
 * of every group's `entries`, in group order, equals the flat keyboard order.
 */
export function groupResultsByPanel(results: readonly SettingsIndexEntry[]): ResultGroup[] {
  const groups: ResultGroup[] = [];
  const byPanel = new Map<PanelId, ResultGroup>();
  for (const entry of results) {
    let group = byPanel.get(entry.panelId);
    if (!group) {
      group = { panelId: entry.panelId, entries: [] };
      byPanel.set(entry.panelId, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

/** The flat, keyboard-navigation order (matches the rendered row order). */
export function flattenGroups(groups: readonly ResultGroup[]): SettingsIndexEntry[] {
  return groups.flatMap((g) => g.entries);
}
