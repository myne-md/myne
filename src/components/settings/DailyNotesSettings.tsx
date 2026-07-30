// Settings → Appearance: daily-notes configuration (MYND-191). Three controls —
// a daily-folder field, a date-format field, and a daily-template designator
// (pick one of the user's templates, or clear it). Each persists **disk-first**
// via the task-1 prefs setters (the write completes before the command returns);
// designating a folder also registers it as a deliberate folder so it survives
// empty. The daily-template designation is a `vault.prefs` pointer the user
// controls — distinct from the template document itself.
//
// Placement: rendered inside the Editor panel (`EditorPanel.tsx`) — note-
// authoring behaviour, not visual appearance. Moved out of Appearance by the
// `docs/decisions.md` taxonomy entry superseding the 2026-05-08 5-panel lock.
// Disk-first + no in-flight gating, matching the other Editor-panel controls.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ControlBlock } from "./ControlBlock";
import { Input } from "../primitives/Input";
import { SearchableSelect } from "../primitives/SearchableSelect";
import type { SelectOption } from "../primitives/Select";
import {
  prefsRead,
  setDailyDateFormat,
  setDailyFolder,
  setDailyTemplate,
} from "../../lib/prefs";
import { listTemplates, type TitleRecord } from "../../notes";
import {
  listFolderPaths,
  type FolderPathOption,
} from "../../notes/listFolderPaths";
import {
  DEFAULT_DAILY_DATE_FORMAT,
  DEFAULT_DAILY_FOLDER,
} from "../../notes";
import i18n from "../../i18n";

// The "blank" sentinel option value — distinct from any note UUID; maps to a
// null `daily_template` pref (an empty note titled with the date).
const BLANK_TEMPLATE = "";

const ERROR_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

function templateName(rec: TitleRecord): string {
  return rec.title?.trim() || i18n.t("settings.dailyNotes.untitledTemplate");
}

export function DailyNotesSettings() {
  const { t } = useTranslation();
  const [folder, setFolder] = useState("");
  const [folderPaths, setFolderPaths] = useState<FolderPathOption[]>([]);
  const [format, setFormat] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TitleRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listFolderPaths()
      .then((paths) => {
        if (!cancelled) setFolderPaths(paths);
      })
      .catch(() => {
        // Locked vault / read failure — the free-text fallback still renders.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((prefs) => {
        if (cancelled) return;
        setFolder(prefs.daily_folder ?? "");
        setFormat(prefs.daily_date_format ?? "");
        setTemplateId(prefs.daily_template);
      })
      .catch(() => {
        /* keep blank-as-default on read failure */
      });
    void listTemplates()
      .then((recs) => {
        if (!cancelled) setTemplates(recs);
      })
      .catch(() => {
        /* designator shows only "Blank" if templates can't be listed */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function persistFolder() {
    await persistFolderValue(folder);
  }

  /** Persist an explicit value — the picker commits on change, not on blur. */
  async function persistFolderValue(raw: string) {
    const value = raw.trim();
    if (value === "") return; // empty → leave the default (None ≡ Daily/)
    setError(null);
    try {
      await setDailyFolder(value);
    } catch {
      setError(t("settings.dailyNotes.folderSaveError"));
    }
  }

  async function persistFormat() {
    const value = format.trim();
    if (value === "") return; // empty → leave the default (None ≡ YYYY-MM-DD)
    setError(null);
    try {
      await setDailyDateFormat(value);
    } catch {
      setError(t("settings.dailyNotes.dateFormatSaveError"));
    }
  }

  async function chooseTemplate(value: string) {
    const next = value === BLANK_TEMPLATE ? null : value;
    setError(null);
    setTemplateId(next);
    try {
      await setDailyTemplate(next);
    } catch {
      setError(t("settings.dailyNotes.templateSaveError"));
    }
  }

  // The default folder is always offerable even when no note is filed there yet
  // (a fresh vault has no `Daily/` until the first daily note is written).
  const folderOptions: SelectOption<string>[] = useMemo(() => {
    const opts = folderPaths.map((f) => ({ value: f.path, label: f.label }));
    if (!opts.some((o) => o.value === DEFAULT_DAILY_FOLDER)) {
      opts.unshift({ value: DEFAULT_DAILY_FOLDER, label: DEFAULT_DAILY_FOLDER });
    }
    return opts;
  }, [folderPaths]);

  const templateOptions: SelectOption<string>[] = [
    { value: BLANK_TEMPLATE, label: t("settings.dailyNotes.blankTemplate") },
    ...templates.map((rec) => ({ value: rec.noteUuid, label: templateName(rec) })),
  ];

  return (
    <>
      <ControlBlock
        label={t("settings.dailyNotes.folderLabel")}
        helper={t("settings.dailyNotes.folderHelper", {
          default: DEFAULT_DAILY_FOLDER,
        })}
        control={
          /* MYND-624: pick an existing folder instead of typing its path.
             The pref itself has always been here; the control was a bare text
             field, so getting it right meant knowing the canonical
             trailing-slash form and spelling it from memory, and a typo
             silently filed daily notes somewhere new. The free-text input
             stays as the fallback for a vault with no folders yet, where a
             one-option dropdown would be worse than a field. Filing dailies
             into a folder that does not exist yet means creating it once in
             the sidebar first -- the trade for not being able to typo the
             path. */
          folderPaths.length > 0 ? (
            <SearchableSelect
              options={folderOptions}
              selected={[folder === "" ? DEFAULT_DAILY_FOLDER : folder]}
              onChange={(next) => {
                const chosen = next[0];
                if (chosen === undefined) return;
                setFolder(chosen);
                void persistFolderValue(chosen);
              }}
              aria-label={t("settings.dailyNotes.folderLabel")}
              testId="settings.daily-folder-select"
              searchPlaceholder={t("settings.dailyNotes.searchPlaceholder")}
              emptyText={t("settings.dailyNotes.searchEmpty")}
            />
          ) : (
            <Input
              value={folder}
              placeholder={DEFAULT_DAILY_FOLDER}
              onChange={(e) => setFolder(e.target.value)}
              onBlur={() => void persistFolder()}
              aria-label={t("settings.dailyNotes.folderLabel")}
              data-testid="settings.daily-folder-input"
            />
          )
        }
      />
      <ControlBlock
        label={t("settings.dailyNotes.dateFormatLabel")}
        helper={t("settings.dailyNotes.dateFormatHelper", {
          default: DEFAULT_DAILY_DATE_FORMAT,
        })}
        control={
          <Input
            value={format}
            placeholder={DEFAULT_DAILY_DATE_FORMAT}
            mono
            onChange={(e) => setFormat(e.target.value)}
            onBlur={() => void persistFormat()}
            aria-label={t("settings.dailyNotes.dateFormatLabel")}
          />
        }
      />
      <ControlBlock
        label={t("settings.dailyNotes.templateLabel")}
        helper={t("settings.dailyNotes.templateHelper")}
        control={
          <div>
            <SearchableSelect
              options={templateOptions}
              selected={[templateId ?? BLANK_TEMPLATE]}
              onChange={(next) => void chooseTemplate(next[0] ?? BLANK_TEMPLATE)}
              aria-label={t("settings.dailyNotes.templateLabel")}
              testId="settings.daily-template-select"
              searchPlaceholder={t("settings.dailyNotes.searchPlaceholder")}
              emptyText={t("settings.dailyNotes.searchEmpty")}
            />
            {error && (
              <p role="alert" style={ERROR_STYLE}>
                {error}
              </p>
            )}
          </div>
        }
      />
    </>
  );
}
