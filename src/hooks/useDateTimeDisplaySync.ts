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

  useEffect(() => {
    // Republish on BOTH inputs, and the language half needs its own listener
    // rather than a dependency (myne-md/myne#609). The first version read
    // `i18n.resolvedLanguage` into a dep, which only works if this component
    // re-renders when the language changes, and it does not: neither `Editor`
    // nor `App` calls `useTranslation`, and `setLanguage` changes the language
    // in place with no reload. So the language was published on the next
    // incidental re-render rather than on the switch, and a `system` date
    // preset kept the old language until something unrelated happened.
    //
    // Measured, not reasoned about: `grep -c useTranslation src/App.tsx` is 0,
    // and the `useTranslation` calls in this screen's file are all below the
    // component that mounts this hook.
    const publish = (): void => {
      setDateTimeDisplay(displayFromPrefs(prefs, i18n.resolvedLanguage ?? i18n.language));
    };
    publish();
    i18n.on("languageChanged", publish);
    return () => {
      i18n.off("languageChanged", publish);
    };
  }, [prefs.date_format, prefs.time_format, prefs.timezone, prefs]);
}
