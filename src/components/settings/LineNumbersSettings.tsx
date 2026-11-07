// Settings → Editor: line-number gutter toggle (editor-line-numbers, MYND-314).
// A single `<Switch>` toggle mirroring SpellSettings' control. Self-
// contained like its sibling controls (SpellSettings / TypographySettings):
// local state loaded on mount, disk-first persist with no in-flight gating.
//
// Default OFF (prose-first — the gutter is opt-in). `null` ≡ unset → host
// default-OFF; only an explicit choice is persisted. The setter bumps the prefs
// nonce, so the open editor (its own `usePrefs`) re-reads and reconfigures its
// line-number compartment live (no remount).
import { useTranslation } from "react-i18next";
import { Switch } from "../primitives/Switch";
import { usePrefValue } from "@myne/client-core/pref-value";
import { SettingRow } from "./SettingRow";
import { prefsRead, setEditorLineNumbers } from "../../lib/prefs";

export function LineNumbersSettings() {
  const { t } = useTranslation();
  const { value: enabled, set: setEnabled, error } = usePrefValue({
    read: prefsRead,
    select: (p) => p.editor_line_numbers ?? false,
    write: setEditorLineNumbers,
    initial: false,
    errorMessage: t("settings.lineNumbers.errorSaveSetting"),
  });

  return (
    <SettingRow
      label={t("settings.lineNumbers.label")}
      helper={t("settings.lineNumbers.helper")}
      error={error}
      control={(helperId) => (
        <Switch
          checked={enabled}
          onChange={() => void setEnabled(!enabled)}
          ariaLabel={t("settings.lineNumbers.label")}
          ariaDescribedBy={helperId}
          testId="settings.line-numbers"
        />
      )}
    />
  );
}
