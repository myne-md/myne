// Settings → Editor: default view mode (reading-source-modes, MYND-299).
// A three-way segmented control (Live preview / Reading / Source) persisting the
// `editor_default_view_mode` pref. Uses the shared `Segmented` primitive (like the
// sibling TypographySettings rows) for a consistent look + E2E hooks. Self-
// contained: local state loaded on mount, disk-first persist, no in-flight gating.
//
// Default "live" (prose-first live-preview). `null` ≡ unset → host default-live;
// only an explicit choice is persisted (live persists as null for byte-stable
// omit-when-default). The setter bumps the prefs nonce, so a newly-opened tab
// picks up the new default (open tabs keep their per-tab mode).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingRow } from "./SettingRow";
import { Segmented } from "../primitives/Segmented";
import { prefsRead, setEditorDefaultViewMode } from "../../lib/prefs";
import { asViewMode, type ViewMode } from "../../editor/view-mode";

// Option values paired with their i18n label keys. Labels resolve with `t(...)`
// at render time — storing resolved strings at module scope would freeze the
// boot language.
const OPTION_KEYS = [
  { value: "live", labelKey: "settings.viewMode.optionLive" },
  { value: "reading", labelKey: "settings.viewMode.optionReading" },
  { value: "source", labelKey: "settings.viewMode.optionSource" },
] as const;

export function DefaultViewModeSettings() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ViewMode>("live");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        setMode(asViewMode(p.editor_default_view_mode));
      })
      .catch(() => {
        /* locked / no vault — leave default live */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function choose(next: ViewMode) {
    const prev = mode;
    setMode(next); // optimistic
    try {
      // "live" is the default — persist it as unset (null) to keep byte-stable
      // omit-when-default; reading/source persist the explicit value.
      await setEditorDefaultViewMode(next === "live" ? null : next);
      setError(null);
    } catch {
      setMode(prev); // rollback
      setError(t("settings.viewMode.errorSave"));
    }
  }

  const options = OPTION_KEYS.map((o) => ({
    value: o.value,
    label: t(o.labelKey),
  }));

  return (
    <SettingRow
      label={t("settings.viewMode.label")}
      helper={t("settings.viewMode.helper")}
      error={error}
      control={
        <Segmented
          options={options}
          value={mode}
          onChange={(v) => void choose(v as ViewMode)}
          ariaLabel={t("settings.viewMode.label")}
          testId="settings.default-view-mode"
        />
      }
    />
  );
}
