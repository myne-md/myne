// Settings → Editor: default view mode (reading-source-modes, MYND-299).
// A three-way picker (Live preview / Reading / Source) persisting the
// `editor_default_view_mode` pref. Uses the shared `Select` primitive (like
// every other row-level picker in Settings, whatever its option count —
// docs/design/README.md "Which picker", myne-md/myne#769) for a consistent look
// + E2E hooks. Self-contained: local state loaded on mount, disk-first persist,
// no in-flight gating.
//
// Default "live" (prose-first live-preview). `null` ≡ unset → host default-live;
// only an explicit choice is persisted (live persists as null for byte-stable
// omit-when-default). The setter bumps the prefs nonce, so a newly-opened tab
// picks up the new default (open tabs keep their per-tab mode).

import { useTranslation } from "react-i18next";
import { SettingRow } from "./SettingRow";
import { Select } from "../primitives/Select";
import { usePrefValue } from "@myne/client-core/pref-value";
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
  const { value: mode, set: setMode, error } = usePrefValue({
    read: prefsRead,
    select: (p) => asViewMode(p.editor_default_view_mode),
    write: (next) => setEditorDefaultViewMode(next === "live" ? null : next),
    initial: "live",
    errorMessage: t("settings.viewMode.errorSave"),
  });
  // keep choose wrapper? onChange calls choose(v as ViewMode). We'll make choose = setMode
  async function choose(next: ViewMode) {
    await setMode(next);
  }

  const options = OPTION_KEYS.map((o) => ({
    value: o.value,
    label: t(o.labelKey),
  }));

  return (
    <SettingRow
      anchorId="editor.view-mode"
      label={t("settings.viewMode.label")}
      helper={t("settings.viewMode.helper")}
      error={error}
      control={(helperId) => (
        <Select
          options={options}
          value={mode}
          onChange={(v) => void choose(v as ViewMode)}
          aria-label={t("settings.viewMode.label")}
          ariaDescribedBy={helperId}
          testId="settings.default-view-mode"
        />
      )}
    />
  );
}
