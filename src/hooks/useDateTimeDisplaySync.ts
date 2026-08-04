// Publishes the resolved date/time display settings into the shared store that
// every formatting surface reads (myne#279).
//
// The store lives in `@myne/editor/host/lib/datetimeFormat` so both packages can
// reach it without either importing the other's prefs layer. This hook is the
// one adapter: prefs + the app's active language in, one `setDateTimeDisplay`
// out. Mounted once, high in the tree — the store fans the change out to every
// subscriber, so nothing else has to thread the settings down.
//
// The language is part of it deliberately. The `system` presets resolve against
// the app's OWN language rather than the OS locale, because following the OS is
// what let a user with Myne in Turkish read British dates in saved views.

import { useEffect } from "react";
import i18n from "../i18n";
import { usePrefs } from "./usePrefs";
import { displayFromPrefs, setDateTimeDisplay } from "../lib/datetimeFormat";

export function useDateTimeDisplaySync(): void {
  const { prefs } = usePrefs();
  const language = i18n.resolvedLanguage ?? i18n.language;

  useEffect(() => {
    setDateTimeDisplay(displayFromPrefs(prefs, language));
  }, [prefs.date_format, prefs.time_format, prefs.timezone, language, prefs]);
}
