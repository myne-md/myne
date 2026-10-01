// Settings → Editor: enable the plain-file editor on this device
// (myne-md/myne#788). On by default and NOT behind Developer mode (amended
// 2026-10-01), so the off-switch is findable by every user.
//
// A DEVICE-LOCAL switch, not a vault preference, and that is the point: the
// surface it gates must work with the vault locked and on a device that has no
// vault at all, which `vault.prefs` cannot do. Read and written through
// `src/platform/plainFile.ts` (its own JSON file under the app config dir).
//
// Self-contained like its siblings (`LineNumbersSettings` / `VimModeSettings`):
// local state on mount, optimistic toggle with rollback on failure.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import { plainFileGateGet, plainFileGateSet } from "../../platform/plainFile";
import { handleGateDisabled } from "../../plain/store";

export function PlainFileSettings() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void plainFileGateGet()
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch(() => {
        /* unreadable gate reads as off (Rust fails closed) */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(next: boolean) {
    const prev = enabled;
    setEnabled(next); // optimistic
    try {
      await plainFileGateSet(next);
    } catch {
      setEnabled(prev); // rollback
      setError(t("settings.plainFile.errorSaveSetting"));
      return;
    }
    if (!next) {
      // Disabling the gate closes the surface's tabs (the PRD's contract):
      // flush them, then drop them. A tab whose text never landed stays open
      // by design, and saying so is the difference between "the switch
      // worked" and a surface that silently ignores it.
      const remaining = await handleGateDisabled();
      if (remaining.length > 0) {
        setError(t("settings.plainFile.openFilesRemain"));
        return;
      }
    }
    setError(null);
  }

  return (
    <SettingRow
      label={t("settings.plainFile.label")}
      helper={t("settings.plainFile.helper")}
      error={error}
      control={(helperId) => (
        <Switch
          checked={enabled}
          onChange={() => void toggle(!enabled)}
          ariaLabel={t("settings.plainFile.label")}
          ariaDescribedBy={helperId}
          testId="settings.plain-file"
        />
      )}
    />
  );
}
