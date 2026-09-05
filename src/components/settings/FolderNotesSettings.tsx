// Settings → Files: the folder-notes feature off-switch (myne-md/myne#661).
//
// Folder notes ship OFF by default. This row is the switch that turns them on.
// When off, the folder-index entry points (the folder-row hover button, the
// folder and note context-menu items, double-click-to-create) are hidden and a
// note's `folder_index: true` flag is not honoured for sidebar or link
// presentation, so an existing folder note simply renders as an ordinary note.
//
// The switch is a PRESENTATION gate only: it never rewrites frontmatter, so a
// note keeping `folder_index: true` while the feature is off is a correct,
// fully-reversible state. Turning the switch back on restores exactly what was
// there.
//
// Default state is OFF, so seeding local state with `false` matches the
// preference default and never flashes the wrong answer before the disk read.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingRow } from "./SettingRow";
import { Switch } from "../primitives/Switch";
import { prefsRead, setFolderNotesEnabled } from "../../lib/prefs";

export function FolderNotesSettings() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        setEnabled(p.folder_notes_enabled);
      })
      .catch(() => {
        /* locked / no vault: leave the default OFF */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(next: boolean) {
    const prev = enabled;
    setEnabled(next); // optimistic
    try {
      await setFolderNotesEnabled(next);
      setError(null);
    } catch {
      setEnabled(prev); // rollback — never leave the UI asserting an unsaved value
      setError(t("settings.folderNotes.errorSaveSetting"));
    }
  }

  return (
    <SettingRow
      label={t("settings.folderNotes.label")}
      helper={t("settings.folderNotes.helper")}
      error={error}
      control={(helperId) => (
        <Switch
          checked={enabled}
          onChange={(next) => void toggle(next)}
          ariaLabel={t("settings.folderNotes.label")}
          ariaDescribedBy={helperId}
          testId="settings.folder-notes-toggle"
        />
      )}
    />
  );
}
