// Query entry point for the Settings search (MYND-536). Builds each index
// entry's localized haystack — title + description + keywords + the owning
// panel's rail label — and runs the accent-folded matcher. Resolving the i18n
// keys at call time (not module load) keeps search text in the current language,
// consistent with the rest of the Settings shell.

import {
  visibleSettingsIndex,
  type SettingsIndexEntry,
} from "./settingsSearchIndex";
import { matchHaystacks } from "./matchSettings";

/** Minimal shape of react-i18next's `t` for the plain-key lookups here. */
type Translate = (key: string) => string;

/** The rail label i18n key for a panel (all live under `settings.shell.panels.*`). */
export function panelLabelKey(panelId: SettingsIndexEntry["panelId"]): string {
  return `settings.shell.panels.${panelId}`;
}

/**
 * Return the index entries matching `query`, best-match first. Including the
 * panel label in the haystack lets a panel name (e.g. "Appearance") surface all
 * of that panel's settings. An empty query returns every entry (index order).
 */
export function searchSettings(query: string, t: Translate): SettingsIndexEntry[] {
  const candidates = visibleSettingsIndex().map((entry) => ({
    item: entry,
    haystacks: [
      t(entry.titleKey),
      entry.descriptionKey ? t(entry.descriptionKey) : "",
      entry.keywordsKey ? t(entry.keywordsKey) : "",
      t(panelLabelKey(entry.panelId)),
    ],
  }));
  return matchHaystacks(candidates, query).map((m) => m.item);
}
