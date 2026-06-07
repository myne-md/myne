// Settings → Appearance: daily-notes configuration (MYND-191). Three controls —
// a daily-folder field, a date-format field, and a daily-template designator
// (pick one of the user's templates, or clear it). Each persists **disk-first**
// via the task-1 prefs setters (the write completes before the command returns);
// designating a folder also registers it as a deliberate folder so it survives
// empty. The daily-template designation is a `vault.prefs` pointer the user
// controls — distinct from the template document itself.
//
// Placement: rendered inside the Appearance panel (the taxonomy is locked to 5
// panels; daily-notes config is preferences-adjacent). Disk-first + no in-flight
// gating, matching the theme control alongside it.

import { useEffect, useState, type CSSProperties } from "react";
import { ControlBlock } from "./ControlBlock";
import { Input } from "../primitives/Input";
import {
  prefsRead,
  setDailyDateFormat,
  setDailyFolder,
  setDailyTemplate,
} from "../../lib/prefs";
import { listTemplates, type TitleRecord } from "../../notes";
import {
  DEFAULT_DAILY_DATE_FORMAT,
  DEFAULT_DAILY_FOLDER,
} from "../../notes";

const SELECT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  padding: "8px 10px",
  borderRadius: "var(--radius-1)",
  border: "1px solid var(--line-2)",
  background: "var(--bg-1)",
  color: "var(--fg-1)",
  alignSelf: "flex-start",
  minWidth: 220,
};

const ERROR_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

function templateName(rec: TitleRecord): string {
  return rec.title?.trim() || "Untitled template";
}

export function DailyNotesSettings() {
  const [folder, setFolder] = useState("");
  const [format, setFormat] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TitleRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

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
    const value = folder.trim();
    if (value === "") return; // empty → leave the default (None ≡ Daily/)
    setError(null);
    try {
      await setDailyFolder(value);
    } catch {
      setError("Couldn't save the daily folder. Please try again.");
    }
  }

  async function persistFormat() {
    const value = format.trim();
    if (value === "") return; // empty → leave the default (None ≡ YYYY-MM-DD)
    setError(null);
    try {
      await setDailyDateFormat(value);
    } catch {
      setError("Couldn't save the date format. Please try again.");
    }
  }

  async function chooseTemplate(value: string) {
    const next = value === "" ? null : value;
    setError(null);
    setTemplateId(next);
    try {
      await setDailyTemplate(next);
    } catch {
      setError("Couldn't save the daily template. Please try again.");
    }
  }

  return (
    <>
      <ControlBlock
        label="Daily note folder"
        helper={`Where new daily notes are filed. Defaults to ${DEFAULT_DAILY_FOLDER} — the folder is kept even when empty.`}
        control={
          <Input
            value={folder}
            placeholder={DEFAULT_DAILY_FOLDER}
            onChange={(e) => setFolder(e.target.value)}
            onBlur={() => void persistFolder()}
            aria-label="Daily note folder"
          />
        }
      />
      <ControlBlock
        label="Daily note date format"
        helper={`The title of each daily note. Supports YYYY, MM, DD. Defaults to ${DEFAULT_DAILY_DATE_FORMAT}.`}
        control={
          <Input
            value={format}
            placeholder={DEFAULT_DAILY_DATE_FORMAT}
            mono
            onChange={(e) => setFormat(e.target.value)}
            onBlur={() => void persistFormat()}
            aria-label="Daily note date format"
          />
        }
      />
      <ControlBlock
        label="Daily note template"
        helper="Pick a template to start each daily note from, or leave blank for an empty note titled with the date."
        control={
          <div>
            <select
              value={templateId ?? ""}
              onChange={(e) => void chooseTemplate(e.target.value)}
              style={SELECT_STYLE}
              aria-label="Daily note template"
            >
              <option value="">Blank (no template)</option>
              {templates.map((rec) => (
                <option key={rec.noteUuid} value={rec.noteUuid}>
                  {templateName(rec)}
                </option>
              ))}
            </select>
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
