// Settings → Editor: line-number gutter toggle (editor-line-numbers, MYND-314).
// A single `<Switch>` toggle mirroring SpellSettings' control. Self-
// contained like its sibling controls (SpellSettings / TypographySettings):
// local state loaded on mount, disk-first persist with no in-flight gating.
//
// Default OFF (prose-first — the gutter is opt-in). `null` ≡ unset → host
// default-OFF; only an explicit choice is persisted. The setter bumps the prefs
// nonce, so the open editor (its own `usePrefs`) re-reads and reconfigures its
// line-number compartment live (no remount).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import { prefsRead, setEditorLineNumbers } from "../../lib/prefs";

export function LineNumbersSettings() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        // null ≡ unset → host default-OFF (prose-first).
        setEnabled(p.editor_line_numbers ?? false);
      })
      .catch(() => {
        /* locked / no vault — leave default OFF */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(next: boolean) {
    const prev = enabled;
    setEnabled(next); // optimistic
    try {
      await setEditorLineNumbers(next);
      setError(null);
    } catch {
      setEnabled(prev); // rollback
      setError(t("settings.lineNumbers.errorSaveSetting"));
    }
  }

  return (
    <SettingRow
      label={t("settings.lineNumbers.label")}
      helper={t("settings.lineNumbers.helper")}
      error={error}
      control={(helperId) => (
        <Switch
          checked={enabled}
          onChange={() => toggle(!enabled)}
          ariaLabel={t("settings.lineNumbers.label")}
          ariaDescribedBy={helperId}
          testId="settings.line-numbers"
        />
      )}
    />
  );
}
