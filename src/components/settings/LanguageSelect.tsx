// Settings → Appearance: the app display-language selector. Unlike the other
// Appearance controls (theme, timestamps) this does NOT persist to the
// encrypted `vault.prefs` blob — language is a device-local UI preference that
// must work pre-unlock, so it routes through `setLanguage` (localStorage +
// `i18n.changeLanguage`). See `src/i18n/config.ts`.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ControlBlock } from "./ControlBlock";
import { setLanguage } from "../../i18n";
import {
  SUPPORTED_CODES,
  SUPPORTED_LANGUAGES,
  type LanguageCode,
} from "../../i18n/config";

const SELECT_STYLE: CSSProperties = {
  alignSelf: "flex-start",
  background: "var(--bg-1)",
  color: "var(--fg-1)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-2) var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  cursor: "pointer",
};

export function LanguageSelect() {
  const { t, i18n } = useTranslation();
  // `resolvedLanguage` is the actually-active locale after fallback (e.g. a
  // regional `tr-TR` resolves to `tr`); guard against an unsupported value so
  // the <select> always has a matching <option>.
  const active = i18n.resolvedLanguage ?? i18n.language;
  const value = SUPPORTED_CODES.includes(active) ? active : "en";

  return (
    <ControlBlock
      label={t("settings.language.label")}
      helper={t("settings.language.helper")}
      control={
        <select
          value={value}
          onChange={(e) => setLanguage(e.currentTarget.value as LanguageCode)}
          style={SELECT_STYLE}
          aria-label={t("settings.language.label")}
          data-testid="settings.language-select"
        >
          {SUPPORTED_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      }
    />
  );
}
