// Task 5 regression (settings-search) — the keyboard order MUST equal the
// on-screen order. `searchSettings` scores matches by RELEVANCE (fuzzyFilter),
// which can interleave panels; the rendered results list then re-groups by
// panel. SettingsModal reconciles the two by ordering its `results` through
// flattenGroups(groupResultsByPanel(…)), so `results[activeIndex]` (the
// arrow-key highlight) walks the exact rows the list renders. Without that
// reconciliation the highlight jumps between panel groups as ↑/↓ move. MYND-536.

import { describe, expect, it } from "vitest";
import en from "../locales/en/common.json";
import { searchSettings } from "../src/components/settings/search/searchSettings";
import {
  flattenGroups,
  groupResultsByPanel,
} from "../src/components/settings/search/resultsGrouping";
import type { SettingsIndexEntry } from "../src/components/settings/search/settingsSearchIndex";

/** Resolve a dotted i18n key against the raw catalog → the string, or undefined. */
function lookup(key: string): string | undefined {
  const v = key
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      en as unknown,
    );
  return typeof v === "string" ? v : undefined;
}
const t = (key: string): string => lookup(key) ?? key;

/** True iff no panel appears in two separate runs — i.e. the list is clustered
 *  by panel, which is exactly the shape the grouped results view renders. */
function isPanelClustered(entries: readonly SettingsIndexEntry[]): boolean {
  const seen = new Set<string>();
  let prev: string | undefined;
  for (const e of entries) {
    if (e.panelId !== prev) {
      if (seen.has(e.panelId)) return false; // a panel resumed after a gap
      seen.add(e.panelId);
      prev = e.panelId;
    }
  }
  return true;
}

/** The exact ordering SettingsModal feeds to both keyboard nav and the list. */
const applied = (query: string): SettingsIndexEntry[] =>
  flattenGroups(groupResultsByPanel(searchSettings(query, t)));

describe("settings-search keyboard/visual order reconciliation", () => {
  it("reconciles an interleaved (relevance-ordered) match list into panel-clustered order", () => {
    // A relevance-ordered match list, as fuzzyFilter can produce for a query
    // hitting several panels at different scores (e.g. a Sync-panel title hit
    // above a Privacy keyword hit above more Sync hits):
    const interleaved: SettingsIndexEntry[] = [
      { id: "sync.status", panelId: "sync", titleKey: "x" },
      { id: "privacy.last-active-note", panelId: "privacy", titleKey: "x" },
      { id: "sync.devices", panelId: "sync", titleKey: "x" },
    ];
    // Precondition — this is the shape that made the highlight jump.
    expect(isPanelClustered(interleaved)).toBe(false);

    const ordered = flattenGroups(groupResultsByPanel(interleaved));
    // Keyboard order is now panel-clustered…
    expect(isPanelClustered(ordered)).toBe(true);
    expect(ordered.map((e) => e.id)).toEqual([
      "sync.status",
      "sync.devices",
      "privacy.last-active-note",
    ]);
    // …and re-grouping it is a no-op, so the rendered rows (which re-group)
    // traverse the same sequence: highlight and rows can never disagree.
    expect(flattenGroups(groupResultsByPanel(ordered))).toEqual(ordered);
  });

  // Over the real registry, the applied order stays clustered + render-stable for
  // any query — the property SettingsModal relies on for arrow-key navigation.
  for (const q of ["sync", "note", "lock", "the", "e", "s"]) {
    it(`"${q}" → panel-clustered order that equals the rendered order`, () => {
      const ordered = applied(q);
      expect(isPanelClustered(ordered)).toBe(true);
      expect(flattenGroups(groupResultsByPanel(ordered))).toEqual(ordered);
    });
  }
});
