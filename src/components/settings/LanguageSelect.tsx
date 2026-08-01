// Settings → Appearance: the app display-language selector. Unlike the other
// Appearance controls (theme, timestamps) this does NOT persist to the
// encrypted `vault.prefs` blob — language is a device-local UI preference that
// must work pre-unlock, so it routes through `setLanguage` (localStorage +
// `i18n.changeLanguage`). See `src/i18n/config.ts`.
//
// The control is `SearchableSelect`, the same primitive Editor → spell uses for
// its own "Languages" picker — the two used to be a custom dropdown and an
// OS-native `<select>` respectively, which made one word name two
// different-looking controls. 24 languages is past the point where a plain
// `Select` is comfortable, so the search box earns its place.

import { useTranslation } from "react-i18next";
import { SettingRow } from "./SettingRow";
import { SearchableSelect } from "../primitives/SearchableSelect";
import { setLanguage } from "../../i18n";
import {
  SUPPORTED_CODES,
  SUPPORTED_LANGUAGES,
  type LanguageCode,
} from "../../i18n/config";

// The option labels are the languages' own endonyms, already in their own
// script — they are NOT translated, so they come straight from the config
// rather than through `t()`.
const LANGUAGE_OPTIONS = SUPPORTED_LANGUAGES.map((l) => ({
  value: l.code,
  label: l.label,
}));

export function LanguageSelect() {
  const { t, i18n } = useTranslation();
  // `resolvedLanguage` is the actually-active locale after fallback (e.g. a
  // regional `tr-TR` resolves to `tr`); guard against an unsupported value so
  // the trigger always summarises a real option.
  const active = i18n.resolvedLanguage ?? i18n.language;
  const value = SUPPORTED_CODES.includes(active) ? active : "en";

  return (
    <SettingRow
      label={t("settings.language.label")}
      helper={t("settings.language.helper")}
      anchorId="appearance.language"
      control={
        <SearchableSelect
          options={LANGUAGE_OPTIONS}
          selected={[value as LanguageCode]}
          onChange={(next) => {
            const chosen = next[0];
            if (chosen === undefined) return;
            setLanguage(chosen);
          }}
          aria-label={t("settings.language.label")}
          testId="settings.language-select"
        />
      }
    />
  );
}
