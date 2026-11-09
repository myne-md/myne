// The phone's event composer (myne-md/myne#1037).
//
// Three fields, because three is what a phone can ask for without becoming a
// form: a title, a day (the cell you tapped) and either a time or all-day. Repeat,
// a reminder lead and the calendar's colour are the desktop form's job for now,
// and this file says so rather than leaving a user to wonder why the event they
// created has none of them.
//
// **It writes through the one writer.** `createEventNote` builds the same bytes
// the desktop `createEvent` builds and calls the phone's own `note_create`, so an
// event created here is byte-identical to one created on a laptop
// (`mobile/src/lib/eventWrite.ts`).

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Segmented, Sheet, Switch, TextField } from "../../components";
import { createEventNote, parseClock } from "../../lib/eventWrite";
import type { EventInstant } from "../../dialect/event";
import { parseCivilDate } from "@myne/dialect-civil-date";

/**
 * `YYYY-MM-DD` plus an optional `HH:MM`, as the dialect's instant.
 *
 * `null` when the clock text is not a time: the caller marks the field rather than
 * writing a value no reader can parse. An all-day event is the ABSENCE of a time
 * half, which is how the dialect spells it, so `clock === null` is not an omission.
 */
function instantFor(date: string, clock: string | null): EventInstant | null {
  const civil = parseCivilDate(date);
  if (civil === null) return null;
  if (clock === null) return { date: civil, time: null };
  const parsed = parseClock(clock);
  if (parsed === null) return null;
  const hh = String(parsed.hours).padStart(2, "0");
  const mm = String(parsed.minutes).padStart(2, "0");
  return { date: civil, time: `${hh}:${mm}` };
}

/**
 * The dialect's canonical phrases, in the order the segments render.
 *
 * Hard-coded rather than built from `formatRecurrenceRule` because these four ARE
 * the phrases that function emits for those rules; a test pins the pair so the
 * spellings cannot drift apart silently.
 */
const REPEAT_VALUES: readonly string[] = ["", "every day", "every week", "every month"];

/** The reminder leads the phone offers, as the file spells them. */
const REMIND_VALUES: readonly string[] = ["", "10m", "1h", "1d"];

export function EventComposerSheet({
  date,
  onClose,
  onCreated,
}: {
  /** The day the composer was opened on, `YYYY-MM-DD`. */
  date: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("");
  const [repeat, setRepeat] = useState("");
  const [remind, setRemind] = useState("");
  const [calendar, setCalendar] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startInstant = allDay ? instantFor(date, null) : instantFor(date, start);
  const endInstant = allDay || end.trim() === "" ? null : instantFor(date, end);
  const startInvalid = startInstant === null;
  const endInvalid = !allDay && end.trim() !== "" && endInstant === null;
  const canCreate = title.trim() !== "" && !startInvalid && !endInvalid && !busy;

  async function create() {
    if (startInstant === null) return;
    setBusy(true);
    setError(null);
    try {
      await createEventNote({
        title: title.trim(),
        start: startInstant,
        end: endInstant,
        // Empty means "the file carries no such field", which is the absence the
        // readers treat as "one-off" and "no reminder" rather than a value.
        repeat: repeat === "" ? null : repeat,
        remind: remind === "" ? null : remind,
        calendar: calendar.trim() === "" ? null : calendar.trim(),
      });
      onCreated();
    } catch {
      setError(t("calendar.composer.createFailed"));
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }} data-testid="calendar.composer">
        <h2 style={{ margin: "var(--space-0)", fontSize: "var(--text-lg)", fontWeight: "var(--weight-semibold, 600)" }}>{t("calendar.composer.title")}</h2>

        <TextField
          label={t("calendar.composer.titleLabel")}
          value={title}
          onChange={setTitle}
          testId="calendar.composer.title-field"
          autoCapitalize="sentences"
        />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: "var(--text-base)" }}>{t("calendar.allDay")}</span>
          <Switch
            on={allDay}
            onToggle={() => setAllDay((current) => !current)}
          />
        </div>

        {!allDay && (
          <div style={{ display: "flex", gap: "var(--space-3)" }}>
            <TextField
              label={t("calendar.composer.start")}
              value={start}
              onChange={setStart}
              testId="calendar.composer.start-field"
              mono
            />
            <TextField
              label={t("calendar.composer.end")}
              value={end}
              onChange={setEnd}
              testId="calendar.composer.end-field"
              mono
            />
          </div>
        )}

        {(startInvalid || endInvalid) && (
          <p role="alert" style={{ margin: "var(--space-0)", fontSize: "var(--text-sm)", color: "var(--danger)" }} data-testid="calendar.composer.invalid">
            {t("calendar.composer.badTime")}
          </p>
        )}
        {error !== null && (
          <p role="alert" style={{ margin: "var(--space-0)", fontSize: "var(--text-sm)", color: "var(--danger)" }} data-testid="calendar.composer.error">
            {error}
          </p>
        )}

        {/* Repeat and reminder are four short choices each rather than the
            desktop's full rule builder: a phone asks "does this repeat weekly"
            and not "every second tuesday of the month". The values are the
            dialect's own canonical phrases, so a rule is spelled one way in both
            clients and the exotic rules stay on the form that can express them. */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-2)" }}>{t("calendar.form.repeat")}</span>
          <Segmented
            ariaLabel={t("calendar.form.repeat")}
            options={[
              t("calendar.composer.repeatNever"),
              t("calendar.composer.repeatDaily"),
              t("calendar.composer.repeatWeekly"),
              t("calendar.composer.repeatMonthly"),
            ]}
            active={REPEAT_VALUES.indexOf(repeat)}
            onChange={(index) => setRepeat(REPEAT_VALUES[index] ?? "")}
            testIdPrefix="calendar.composer.repeat"
            optionValues={["never", "daily", "weekly", "monthly"]}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-2)" }}>{t("calendar.form.remind")}</span>
          <Segmented
            ariaLabel={t("calendar.form.remind")}
            options={[
              t("calendar.composer.remindNone"),
              "10m",
              "1h",
              "1d",
            ]}
            active={REMIND_VALUES.indexOf(remind)}
            onChange={(index) => setRemind(REMIND_VALUES[index] ?? "")}
            testIdPrefix="calendar.composer.remind"
            optionValues={["none", "10m", "1h", "1d"]}
          />
        </div>

        <TextField
          label={t("calendar.composer.calendarLabel")}
          value={calendar}
          onChange={setCalendar}
          testId="calendar.composer.calendar-field"
          autoCapitalize="words"
        />

        <Button disabled={!canCreate} onClick={() => void create()} data-testid="calendar.composer.create">
          {t("calendar.composer.create")}
        </Button>
        <Button variant="ghost" onClick={onClose} data-testid="calendar.composer.cancel">
          {t("common.cancel")}
        </Button>
      </div>
    </Sheet>
  );
}
