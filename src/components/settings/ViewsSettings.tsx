// Settings → Editor: Views feature toggle (device-local, `lib/viewsEnabled.ts`).
//
// A single <Switch> mirroring ArchiveSettings' control, but backed by a
// device-local localStorage pref rather than `vault.prefs`. Effective state =
// the stored pref if set, else the back-compat default (the vault already has
// saved views → ON; a fresh vault → OFF). Writing bumps VIEWS_ENABLED_EVENT so
// the sidebar's "Views" entry appears/disappears live.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import { prefsRead } from "../../lib/prefs";
import { readViewsEnabledPref, writeViewsEnabled } from "../../lib/viewsEnabled";

export function ViewsSettings() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean>(
    () => readViewsEnabledPref() ?? false,
  );

  useEffect(() => {
    // Untouched toggle → derive the effective default from whether the vault
    // already has views (existing views user starts ON; fresh vault OFF).
    if (readViewsEnabledPref() !== null) return;
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (!cancelled) setEnabled(p.saved_views.length > 0);
      })
      .catch(() => {
        /* locked / no vault — leave default OFF */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SettingRow
      label={t("settings.views.label")}
      helper={t("settings.views.helper")}
      control={(helperId) => (
        <Switch
          checked={enabled}
          onChange={() => {
            const next = !enabled;
            setEnabled(next);
            writeViewsEnabled(next);
          }}
          ariaLabel={t("settings.views.label")}
          ariaDescribedBy={helperId}
          testId="settings.views-enabled"
        />
      )}
    />
  );
}
