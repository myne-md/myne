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
 *
 * `developerModeEnabled` gates the entries tagged `developerGated` in the
 * index (the AI settings, MYND-593) — a search for "AI" or "model" must not
 * navigate into a panel the rail itself would refuse to show.
 *
 * `memberVault` gates the entries tagged `memberVaultGated` (myne-md/myne#885):
 * the shared-vault-unlock row renders only while a member vault is active, so a
 * search must not send a single-account user to an anchor that is not there.
 * Both runtime gates default closed, so a caller that has not resolved the value
 * hides the entry rather than offering a setting that does not render.
 */
export function searchSettings(
  query: string,
  t: Translate,
  developerModeEnabled: boolean,
  memberVault = false,
): SettingsIndexEntry[] {
  const candidates = visibleSettingsIndex(developerModeEnabled, memberVault).map((entry) => ({
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
