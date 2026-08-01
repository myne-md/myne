// Settings → Files: default location for new notes (MYND-462). A mode Select
// (vault root / same folder as current note / a specific folder) plus, when the
// mode is "specific", a folder-path Input. Persists disk-first via
// setNewNoteLocation; designating a specific folder also registers it as a
// deliberate folder backend-side (so it survives empty, the daily_folder
// discipline). The resolved location is applied at note-creation time in
// sidebarState.createAndStartRename — this panel only writes the preference.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingRow } from "./SettingRow";
import { Input } from "../primitives/Input";
import { Select, type SelectOption } from "../primitives/Select";
import {
  prefsRead,
  setNewNoteLocation,
  normalizeNewNoteLocation,
  type NewNoteLocation,
} from "../../lib/prefs";
import { normalizeFolderPath } from "../../dialect/folderPath";

export function NewNoteLocationSettings() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<NewNoteLocation>("root");
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((prefs) => {
        if (cancelled) return;
        setMode(normalizeNewNoteLocation(prefs.new_note_location));
        setFolder(prefs.new_note_location_folder ?? "");
      })
      .catch(() => {
        /* keep the root default on read failure */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options: SelectOption<NewNoteLocation>[] = [
    { value: "root", label: t("settings.files.newNote.optionRoot") },
    { value: "current", label: t("settings.files.newNote.optionCurrent") },
    { value: "specific", label: t("settings.files.newNote.optionSpecific") },
  ];

  async function persist(nextMode: NewNoteLocation, nextFolder: string) {
    setError(null);
    const folderArg =
      nextMode === "specific" ? normalizeFolderPath(nextFolder.trim()) : null;
    try {
      await setNewNoteLocation(nextMode, folderArg);
    } catch {
      setError(t("settings.files.newNote.saveError"));
    }
  }

  async function chooseMode(next: NewNoteLocation) {
    setMode(next);
    // root / current persist immediately; specific waits for a non-empty folder
    // (the Input's onBlur) so we never write a half-set "specific + no folder".
    if (next !== "specific") {
      await persist(next, "");
    } else if (folder.trim() !== "") {
      await persist(next, folder);
    }
  }

  return (
    <SettingRow
      label={t("settings.files.newNote.label")}
      helper={t("settings.files.newNote.helper")}
      error={error}
      control={
        <Select
          value={mode}
          options={options}
          onChange={(next) => void chooseMode(next)}
          aria-label={t("settings.files.newNote.label")}
          testId="settings.new-note-location-select"
        />
      }
    >
      {/* Only for "a specific folder", and a path field wants the full width. */}
      {mode === "specific" && (
        <Input
          value={folder}
          placeholder={t("settings.files.newNote.folderPlaceholder")}
          onChange={(e) => setFolder(e.target.value)}
          onBlur={() => void persist("specific", folder)}
          aria-label={t("settings.files.newNote.folderLabel")}
          data-testid="settings.new-note-location-folder-input"
        />
      )}
    </SettingRow>
  );
}
