// Settings → Appearance: spell-check configuration (MYND-267). A toggle
// (`spell_enabled`) + a multi-select language picker over the bundled-language
// manifest (`BUNDLED_SPELL_LANGUAGES` — the single source, never hard-coded).
// Each control persists **disk-first** via the MYND-262/266 prefs setters; no
// in-flight gating (matches the theme / daily-notes controls alongside).
//
// Placement: inside the Appearance panel (the 5-panel taxonomy is locked;
// spell-check is preferences-adjacent — the DailyNotesSettings precedent). v1
// bundles 23 languages (TR deferred, SYNC-12); the picker lists exactly the
// manifest, so adding a bundled language surfaces here with no edit.

import { useEffect, useState, type CSSProperties } from "react";
import { ControlBlock } from "./ControlBlock";
import { BLOCK_STYLE, LABEL_STYLE, HELPER_STYLE } from "./panel-styles";
import {
  prefsRead,
  setSpellEnabled,
  setSpellLanguages,
} from "../../lib/prefs";
import {
  BUNDLED_SPELL_LANGUAGES,
  defaultActiveLanguages,
  setActiveSpellLanguages,
} from "../../lib/spell";
import { setSpellConfig } from "../../editor/decorations/spell";

const TOGGLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  padding: "6px 12px",
  borderRadius: "var(--radius-1)",
  border: "1px solid var(--line-2)",
  background: "var(--bg-1)",
  color: "var(--fg-1)",
  cursor: "pointer",
  alignSelf: "flex-start",
};

const PICKER_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  alignSelf: "flex-start",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--fg-1)",
};

const ERROR_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

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
  hr: "Hrvatski",
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

export function SpellSettings() {
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
      setError("Could not save the spell-check setting.");
    }
  }

  async function toggleLanguage(tag: string, on: boolean) {
    const next = on ? [...new Set([...active, tag])] : active.filter((t) => t !== tag);
    const prev = active;
    setActive(next); // optimistic
    try {
      await setSpellLanguages(next);
      setSpellConfig(enabled, next); // live-update the open editor
      // Drop the dict of a just-removed language; an added one lazy-loads on the
      // next scan. Only when enabled (disabled → already freed in toggleEnabled).
      if (enabled) void setActiveSpellLanguages(next);
      setError(null);
    } catch {
      setActive(prev); // rollback
      setError("Could not save the spell-check languages.");
    }
  }

  return (
    <>
      <ControlBlock
        label="Spell check"
        helper="Underline misspelled words as you type. Fully offline — your notes never leave the device."
        control={
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Spell check"
            data-testid="settings.spell-check"
            onClick={() => void toggleEnabled(!enabled)}
            style={TOGGLE_STYLE}
          >
            {enabled ? "On" : "Off"}
          </button>
        }
      />

      <div style={BLOCK_STYLE}>
        <span style={LABEL_STYLE} id="spell-langs-label">
          Languages
        </span>
        <div
          role="group"
          aria-labelledby="spell-langs-label"
          data-testid="settings.spell-language-select"
          style={PICKER_STYLE}
        >
          {BUNDLED_SPELL_LANGUAGES.map((tag) => (
            <label key={tag} style={ROW_STYLE} data-lang={tag}>
              <input
                type="checkbox"
                checked={active.includes(tag)}
                disabled={!enabled}
                onChange={(e) => void toggleLanguage(tag, e.target.checked)}
              />
              {langLabel(tag)}
            </label>
          ))}
        </div>
        <p style={HELPER_STYLE}>
          A word is correct if it’s valid in any selected language — handy for
          mixing English terms into other-language notes.
        </p>
      </div>

      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
