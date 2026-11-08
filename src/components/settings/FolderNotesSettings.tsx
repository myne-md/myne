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

import { useTranslation } from "react-i18next";
import { SettingRow } from "./SettingRow";
import { Switch } from "../primitives/Switch";
import { usePrefValue } from "@myne/client-core/pref-value";
import { prefsRead, setFolderNotesEnabled } from "../../lib/prefs";

export function FolderNotesSettings() {
  const { t } = useTranslation();
  const { value: enabled, set: setEnabled, error } = usePrefValue({
    read: prefsRead,
    select: (p) => p.folder_notes_enabled,
    write: setFolderNotesEnabled,
    initial: false,
    errorMessage: t("settings.folderNotes.errorSaveSetting"),
  });

  return (
    <SettingRow
      label={t("settings.folderNotes.label")}
      testId="settings.folder-notes"
      // 326 characters was the third-longest helper in the catalog
      // (myne-md/myne#885). What the feature IS stays on the row; what happens
      // when it is turned off, and that nothing changes on disk, moves behind
      // the question mark unchanged.
      helper={t("settings.folderNotes.inline")}
      explanation={[t("settings.folderNotes.helper")]}
      error={error}
      control={(helperId, explanationId) => (
        <Switch
          checked={enabled}
          onChange={(next) => void setEnabled(next)}
          ariaLabel={t("settings.folderNotes.label")}
          ariaDescribedBy={
            explanationId === undefined
              ? helperId
              : `${helperId} ${explanationId}`
          }
          testId="settings.folder-notes-toggle"
        />
      )}
    />
  );
}
