// Settings → Files: which file opens on app startup (MYND-462). A mode Select
// (last opened / new note / a specific note) plus, when the mode is "specific",
// a SearchableSelect note picker over the vault's LIVE notes (trashed / archived
// / template records excluded). Persists disk-first via setStartupOpen. The
// actual startup behaviour is applied in Editor.tsx's restore effect — this
// panel only writes the preference.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingRow } from "./SettingRow";
import { SearchableSelect } from "../primitives/SearchableSelect";
import { Select, type SelectOption } from "../primitives/Select";
import {
  prefsRead,
  setStartupOpen,
  normalizeStartupOpen,
  type StartupOpen,
} from "../../lib/prefs";
import { noteList, loadNoteBatch, type TitleRecord } from "../../notes";
import i18n from "../../i18n";

function noteName(rec: TitleRecord): string {
  return rec.title?.trim() || i18n.t("common.untitled");
}

/** Enumerate the vault's live notes (excluding trashed / archived / templates),
 *  the candidate set for the startup-note picker. */
async function listLiveNotes(): Promise<TitleRecord[]> {
  const ids = await noteList();
  const records = await loadNoteBatch(ids);
  return records.filter(
    (r) => r.trashed === null && r.archived === null && r.template !== true,
  );
}

export function StartupOpenSettings() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<StartupOpen>("last");
  const [noteId, setNoteId] = useState<string | null>(null);
  const [notes, setNotes] = useState<TitleRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((prefs) => {
        if (cancelled) return;
        setMode(normalizeStartupOpen(prefs.startup_open));
        setNoteId(prefs.startup_open_note);
      })
      .catch(() => {
        /* keep the "last opened" default on read failure */
      });
    void listLiveNotes()
      .then((recs) => {
        if (!cancelled) setNotes(recs);
      })
      .catch(() => {
        /* picker shows the empty state if notes can't be listed */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const modeOptions: SelectOption<StartupOpen>[] = [
    { value: "last", label: t("settings.files.startup.optionLast") },
    { value: "empty", label: t("common.newnote") },
    { value: "specific", label: t("settings.files.startup.optionSpecific") },
  ];

  const noteOptions: SelectOption<string>[] = notes.map((rec) => ({
    value: rec.noteUuid,
    label: noteName(rec),
  }));

  async function persist(nextMode: StartupOpen, nextNote: string | null) {
    setError(null);
    try {
      await setStartupOpen(nextMode, nextMode === "specific" ? nextNote : null);
    } catch {
      setError(t("settings.files.startup.saveError"));
    }
  }

  async function chooseMode(next: StartupOpen) {
    setMode(next);
    // last / empty persist immediately; specific waits until a note is picked
    // so we never write a half-set "specific + no note".
    if (next !== "specific") {
      await persist(next, null);
    } else if (noteId !== null) {
      await persist(next, noteId);
    }
  }

  async function chooseNote(next: string | null) {
    setNoteId(next);
    if (next !== null) await persist("specific", next);
  }

  return (
    <SettingRow
      label={t("settings.files.startup.label")}
      helper={t("settings.files.startup.helper")}
      error={error}
      control={
        <Select
          value={mode}
          options={modeOptions}
          onChange={(next) => void chooseMode(next)}
          aria-label={t("settings.files.startup.label")}
          testId="settings.startup-open-select"
        />
      }
    >
      {/* The note picker only exists for "a specific note", and it is a
          full-width control in its own right — so it sits under the row
          rather than beside the label. */}
      {mode === "specific" && (
        <SearchableSelect
          options={noteOptions}
          selected={noteId === null ? [] : [noteId]}
          onChange={(next) => void chooseNote(next[0] ?? null)}
          aria-label={t("settings.files.startup.noteLabel")}
          testId="settings.startup-open-note-select"
          placeholder={t("settings.files.startup.notePlaceholder")}
          searchPlaceholder={t("settings.files.startup.searchPlaceholder")}
          emptyText={t("settings.files.startup.searchEmpty")}
        />
      )}
    </SettingRow>
  );
}
