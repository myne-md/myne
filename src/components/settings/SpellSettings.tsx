// Settings → Appearance: spell-check configuration (MYND-267). A toggle
// (`spell_enabled`) + a multi-select language picker over the bundled-language
// manifest (`BUNDLED_SPELL_LANGUAGES` — the single source, never hard-coded).
// Each control persists **disk-first** via the MYND-262/266 prefs setters; no
// in-flight gating (matches the theme / daily-notes controls alongside).
//
// Placement: inside the Editor panel (`EditorPanel.tsx`) — note-authoring
// behaviour, not visual appearance. Moved out of Appearance by the
// `design-notes.md` taxonomy entry superseding the 2026-05-08 5-panel lock
// (the DailyNotesSettings precedent moved alongside it). v1 bundles 23
// languages (TR deferred, SYNC-12); the picker lists exactly the manifest, so
// adding a bundled language surfaces here with no edit.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import { SearchableSelect } from "../primitives/SearchableSelect";
import type { SelectOption } from "../primitives/Select";
import { ERROR_STYLE } from "./panel-styles";
import {
  prefsRead,
  setSpellEnabled,
  mutateSpellLanguages,
  mutationFrom,
} from "../../lib/prefs";
import {
  BUNDLED_SPELL_LANGUAGES,
  defaultActiveLanguages,
  setActiveSpellLanguages,
} from "../../lib/spell";
import { setSpellConfig } from "../../editor/decorations/spell";

/** Human label (native endonym) for a BCP-47 tag. Falls back to the raw tag for
 *  any future bundled language without an entry here. */
const LANG_LABELS: Record<string, string> = {
  "en-US": "English (US)",
  "en-GB": "English (UK)",
  bg: "Български",
  ca: "Català",
  de: "Deutsch",
  es: "Español",
  fa: "فارسی",
  fr: "Français",
  he: "עברית",
  hu: "Magyar",
  it: "Italiano",
  ko: "한국어",
  lt: "Lietuvių",
  lv: "Latviešu",
  nl: "Nederlands",
  pl: "Polski",
  pt: "Português",
  ro: "Română",
  ru: "Русский",
  sk: "Slovenčina",
  sl: "Slovenščina",
  sv: "Svenska",
  tr: "Türkçe",
};

function langLabel(tag: string): string {
  return LANG_LABELS[tag] ?? tag;
}

/** The bundled languages as dropdown options, sorted by their display label so
 *  the searchable list reads alphabetically (en-US stays the manifest default
 *  for selection, but order here is purely presentational). */
const LANG_OPTIONS: readonly SelectOption<string>[] = [...BUNDLED_SPELL_LANGUAGES]
  .map((tag) => ({ value: tag, label: langLabel(tag) }))
  .sort((a, b) => a.label.localeCompare(b.label));

export function SpellSettings() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(true);
  const [active, setActive] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        // null ≡ unset → host default-ON (SYNC-15).
        setEnabled(p.spell_enabled ?? true);
        setActive(
          p.spell_languages.length > 0
            ? p.spell_languages
            : defaultActiveLanguages(),
        );
      })
      .catch(() => {
        /* locked / no vault — leave defaults */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleEnabled(next: boolean) {
    const prev = enabled;
    setEnabled(next); // optimistic
    try {
      await setSpellEnabled(next);
      setSpellConfig(next, active); // live-update the open editor
      // Free all loaded dictionaries when turning off; on → they lazy-reload.
      void setActiveSpellLanguages(next ? active : []);
      setError(null);
    } catch {
      setEnabled(prev); // rollback
      setError(t("settings.spell.errorSaveSetting"));
    }
  }

  async function setLanguages(next: string[]) {
    const prev = active;
    setActive(next); // optimistic
    try {
      // `prev` is this component's own previous value, so the delta is what
      // the user just did rather than a claim about the whole stored set.
      await mutateSpellLanguages(mutationFrom(prev, next));
      setSpellConfig(enabled, next); // live-update the open editor
      // Drop the dicts of just-removed languages; added ones lazy-load on the
      // next scan. Only when enabled (disabled → already freed in toggleEnabled).
      if (enabled) void setActiveSpellLanguages(next);
      setError(null);
    } catch {
      setActive(prev); // rollback
      setError(t("settings.spell.errorSaveLanguages"));
    }
  }

  return (
    <>
      <SettingRow
        label={t("settings.spell.label")}
        helper={t("settings.spell.helper")}
        control={(helperId) => (
          <Switch
            checked={enabled}
            onChange={() => void toggleEnabled(!enabled)}
            ariaLabel={t("settings.spell.label")}
            ariaDescribedBy={helperId}
            testId="settings.spell-check"
          />
        )}
      />

      <SettingRow
        anchorId="editor.spell-languages"
        label={t("settings.spell.languagesLabel")}
        helper={t("settings.spell.languagesHelper")}
        control={
          <SearchableSelect
            multiple
            options={LANG_OPTIONS}
            selected={active}
            onChange={(next) => void setLanguages(next)}
            disabled={!enabled}
            aria-label={t("settings.spell.languagesAriaLabel")}
            testId="settings.spell-language-select"
            placeholder={t("settings.spell.languagesPlaceholder")}
            searchPlaceholder={t("settings.spell.languagesSearchPlaceholder")}
            emptyText={t("settings.spell.languagesSearchEmpty")}
          />
        }
      />

      {/* Either the toggle or the language set can set this. */}
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
