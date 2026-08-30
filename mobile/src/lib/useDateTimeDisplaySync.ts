// Publishes the resolved date/time display settings into the shared store that
// every formatting surface reads (myne-md/myne#609).
//
// The desktop twin is `src/hooks/useDateTimeDisplaySync.ts`, and until this file
// existed it was the ONLY caller of `setDateTimeDisplay` in the whole tree. That
// is the defect this feature was filed for: mobile READS the store, through the
// task panel it borrows from the desktop, and wrote nothing into it, so the
// store sat at its defaults for the life of the process. `date_format` and
// `time_format` are shared scalar-LWW, so a value chosen on a computer syncs
// into `vault.prefs` and reaches the phone. The phone was holding it and
// printing something else.
//
// Nothing but a compiler would have caught that, and no compiler can: the store
// has a publisher/consumer split with no gate between the halves. That is why
// `scripts/check-datetime-display-publisher.mjs` lands with this file.
//
// **It reads prefs directly rather than through `usePrefs`, and that is not a
// style choice.** This hook is mounted at the app root so it can never unmount,
// and `usePrefs` holds React state plus its own `prefsRead()` IPC per instance
// with no shared cache. Mounting it at the root through `usePrefs` would add one
// vault decrypt and one whole-app re-render to EVERY prefs write, and
// `use-prefs.ts` records that a single user action can advance the nonce four
// times in separate microtasks that the nonce module does not coalesce. So a
// folder rename would cost four extra decrypts and four extra full-tree renders,
// for three scalars that render nothing.
//
// The language is part of the published value deliberately. The `system`
// presets resolve against the app's OWN language rather than the OS locale,
// because following the OS is what let a user with Myne in Turkish read British
// dates. It gets its own listener rather than a dependency for the reason the
// desktop twin records at length: the mounting component does not re-render on
// a language change, so a dependency publishes on the next incidental render
// instead of on the switch.

import { useEffect } from "react";
import i18n from "@myne/i18n";
import { prefsRead } from "./prefs";
import { usePrefsNonce } from "./prefsNonce";
import { displayFromPrefs, setDateTimeDisplay } from "@myne/editor/host/lib/datetimeFormat";

export function useDateTimeDisplaySync(): void {
  const nonce = usePrefsNonce();

  useEffect(() => {
    let cancelled = false;
    const publish = (prefs: Parameters<typeof displayFromPrefs>[0]): void => {
      if (cancelled) return;
      setDateTimeDisplay(displayFromPrefs(prefs, i18n.resolvedLanguage ?? i18n.language));
    };

    let latest: Parameters<typeof displayFromPrefs>[0] = null;
    void prefsRead()
      .then((p) => {
        latest = p;
        publish(p);
      })
      .catch((err: unknown) => {
        // PUBLISH DEFAULTS rather than nothing. The store is module-scope and
        // outlives every unmount, so "keep what is there" means keeping the
        // PREVIOUS vault's format and zone after a lock or a vault switch, and
        // the zone is a coarse-location datum kept per vault everywhere else.
        // `null` prefs resolve to `DEFAULT_DISPLAY`, which is the honest reading
        // of "no preference is readable right now".
        latest = null;
        publish(null);
        // A locked slot is the ordinary case and says nothing. Anything else is
        // a missing ACL row, an IPC transport failure or a decode failure, and
        // all three produce the identical silent outcome this whole issue was
        // filed about, so they are not swallowed with it.
        //
        // Read the TAG, not the stringified error. `PrefsReadError` is
        // `#[serde(tag = "kind", content = "detail")]`, so `invoke` rejects with
        // an OBJECT and `String(err)` is `"[object Object]"`, which contains
        // neither spelling. The first version matched on those substrings, so
        // the quiet arm could never be taken: this hook mounts above the stage
        // machine and hits a locked slot on every launch, and its own spec
        // rejected with `new Error("SlotNotUnlocked")`, a shape production never
        // produces, so the test agreed with the bug (myne-md/myne#609, found in
        // review). `src/lib/themes.ts` is the convention this now follows.
        const kind = (err as { kind?: unknown } | null)?.kind;
        if (kind !== "SlotNotUnlocked") {
          console.error("[dateTimeDisplay] prefs read failed", err);
        }
      });

    // A language switch republishes what was last read rather than re-reading:
    // the language is not in the blob, so a second decrypt would answer a
    // question nobody asked.
    const onLanguage = (): void => publish(latest);
    i18n.on("languageChanged", onLanguage);
    return () => {
      cancelled = true;
      i18n.off("languageChanged", onLanguage);
    };
  }, [nonce]);
}
