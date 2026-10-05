// Settings → Editor → Text & display: how dates and times are PRINTED (myne#279).
//
// Three rows over the `date_format` / `time_format` / `timezone` prefs. Each
// vocabulary is CLOSED — the same reasoning that keeps the recurrence vocabulary
// closed: a free-text pattern string is a mini-language to validate, localize
// and round-trip, for a setting most people set once.
//
// The timezone row is worth reading twice, because what it does is narrower than
// it looks. `dialect/src/taskFields.ts` is normative that note times are
// zone-free local wall-clock — "09:00" means 09:00 wherever the user is — and
// this setting does not walk that back. It decides what the app treats as
// "today" and how a genuine INSTANT (an attachment's `created_at`) is printed.
// A stored note date or time is never converted, and no zone identifier ever
// reaches a `.myn` file, so a note never records where its author was.
//
// Be exact about the rest of the reach, because the looser claim was written
// here first and this file is one of nine that carried it: the zone DOES live in
// the encrypted `vault.prefs` blob, which is pushed and pulled like every other
// prefs field. `PrefClass::DeviceLocal` is a MERGE classification
// (`sync-protocol.md` 10.2), meaning the local value survives the merge, and
// 10.2.1 has a newly enrolled device adopt it as a starting default.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingRow } from "./SettingRow";
import { Select } from "../primitives/Select";
import { prefsRead, setDateFormat, setTimeFormat, setTimezone } from "../../lib/prefs";
import {
  DATE_FORMATS,
  TIME_FORMATS,
  asDateFormat,
  asTimeFormat,
  formatCivilDate,
  isSupportedTimeZone,
  type DateFormat,
  type TimeFormat,
} from "../../lib/datetimeFormat";
import { useDateTimeDisplay } from "../../lib/useDateTimeDisplay";

/** A fixed sample so each option's label carries a worked example — the whole
 *  point of the setting is what the output looks like. */
const SAMPLE_DATE = "2026-08-01";


export function DateTimeSettings() {
  const { t } = useTranslation();
  const display = useDateTimeDisplay();
  const [dateFormat, setDateFormatState] = useState<DateFormat>("system");
  const [timeFormat, setTimeFormatState] = useState<TimeFormat>("system");
  const [zone, setZone] = useState<string>("");
  const [dateError, setDateError] = useState<string | null>(null);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [zoneError, setZoneError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        setDateFormatState(asDateFormat(p.date_format));
        setTimeFormatState(asTimeFormat(p.time_format));
        setZone(p.timezone ?? "");
      })
      .catch(() => {
        /* locked / no vault — leave the system defaults */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function chooseDate(next: DateFormat) {
    const prev = dateFormat;
    setDateFormatState(next); // optimistic
    try {
      // `system` is the default — persist it as unset so a vault that never
      // chose a format stays byte-identical to a pre-feature one.
      await setDateFormat(next === "system" ? null : next);
      setDateError(null);
    } catch {
      setDateFormatState(prev);
      setDateError(t("settings.dateTime.errorSave"));
    }
  }

  async function chooseTime(next: TimeFormat) {
    const prev = timeFormat;
    setTimeFormatState(next);
    try {
      await setTimeFormat(next === "system" ? null : next);
      setTimeError(null);
    } catch {
      setTimeFormatState(prev);
      setTimeError(t("settings.dateTime.errorSave"));
    }
  }

  async function commitZone(raw: string) {
    const next = raw.trim();
    // Refuse a zone this runtime cannot format in, rather than storing a value
    // that silently reads as "unset" forever. Clearing the field is always
    // allowed — that IS "follow this device".
    if (next !== "" && !isSupportedTimeZone(next)) {
      setZoneError(t("settings.dateTime.zoneUnknown"));
      return;
    }
    try {
      await setTimezone(next === "" ? null : next);
      setZoneError(null);
    } catch {
      setZoneError(t("settings.dateTime.errorSave"));
    }
  }

  const dateOptions = (DATE_FORMATS as readonly DateFormat[]).map((value) => ({
    value,
    label:
      value === "system"
        ? t("settings.dateTime.dateSystem")
        : formatCivilDate(SAMPLE_DATE, { ...display, dateFormat: value }),
  }));

  const timeOptions = (TIME_FORMATS as readonly TimeFormat[]).map((value) => ({
    value,
    label:
      value === "system"
        ? t("settings.dateTime.timeSystem")
        : t(`settings.dateTime.time${value === "24h" ? "24" : "12"}`),
  }));

  return (
    <>
      <SettingRow
        anchorId="editor.date-format"
        label={t("settings.dateTime.dateLabel")}
        helper={t("settings.dateTime.dateHelper")}
        error={dateError}
        control={
          // Every row-level picker in Settings is a `Select`, whatever its
          // option count — the count rule's Settings-list override
          // (docs/design/README.md "Which picker"; myne-md/myne#769, which
          // finished what #668 started on this row alone). The zone row below
          // is a free-text input because a timezone is not a fixed list.
          <Select
            options={dateOptions}
            value={dateFormat}
            onChange={(v) => void chooseDate(v)}
            aria-label={t("settings.dateTime.dateLabel")}
            testId="settings.date-format"
          />
        }
      />
      <SettingRow
        anchorId="editor.time-format"
        label={t("settings.dateTime.timeLabel")}
        helper={t("settings.dateTime.timeHelper")}
        error={timeError}
        control={
          <Select
            options={timeOptions}
            value={timeFormat}
            onChange={(v) => void chooseTime(v as TimeFormat)}
            aria-label={t("settings.dateTime.timeLabel")}
            testId="settings.time-format"
          />
        }
      />
      <SettingRow
        anchorId="editor.timezone"
        label={t("settings.dateTime.zoneLabel")}
        helper={t("settings.dateTime.zoneHelper")}
        error={zoneError}
        control={
          <input
            type="text"
            value={zone}
            placeholder={t("settings.dateTime.zonePlaceholder")}
            aria-label={t("settings.dateTime.zoneLabel")}
            data-testid="settings.timezone"
            onChange={(e) => {
              setZone(e.target.value);
              setZoneError(null);
            }}
            onBlur={(e) => void commitZone(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              void commitZone((e.target as HTMLInputElement).value);
            }}
            style={{
              width: "16rem",
              padding: "var(--space-1) var(--space-2)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-1)",
              background: "var(--bg-1)",
              color: "var(--fg-1)",
              font: "inherit",
            }}
          />
        }
      />
    </>
  );
}
