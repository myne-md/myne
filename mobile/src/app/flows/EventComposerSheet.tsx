// The phone's event sheet: the same six fields, whether the event is new or not
// (myne-md/myne#1037).
//
// # Two modes, one sheet
//
// `edit` absent means CREATE, through `createEventNote`, which builds the same bytes
// the desktop `createEvent` builds and calls the phone's own `note_create`. `edit`
// present means SAVE, through the shared `applyEventEdit` (`@myne/calendar-update`):
// the writer the desktop form uses, patching the same six frontmatter fields behind
// the same value anchor and base hash, so a concurrent pull turns into a named
// refusal instead of an overwrite.
//
// # What the segmented controls may not express
//
// Repeat and reminder are four short choices each rather than the desktop's rule
// builder. A file may legally carry a rule this sheet cannot draw (`repeat: 1w`), and
// saving must not delete it: `applyEventEdit` treats `undefined` as "leave the line
// alone", so an unrepresentable value arrives absent rather than null.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Segmented, Sheet, Switch, TextField } from "../../components";
import { createEventNote, parseClock } from "../../lib/eventWrite";
import { formatEventInstant, parseEventInstant, type EventInstant } from "../../dialect/event";
import { parseCivilDate } from "@myne/dialect-civil-date";
import type { CalendarRow } from "@myne/vault-indices";
import { applyEventEdit } from "@myne/calendar-update";
import { EventWriteRefused } from "@myne/calendar-drag-write";
import { noteRead, noteUpdate } from "../../lib/notes";

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
  startTime,
  endTime,
  edit,
  onClose,
  onCreated,
}: {
  /** The day the composer was opened on, `YYYY-MM-DD`. */
  date: string;
  /** The clock a create-drag or a tap on the hour axis landed on, `HH:MM`. */
  startTime?: string;
  endTime?: string;
  /** The row being changed. Absent, the sheet creates. */
  edit?: CalendarRow;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const existing = edit === undefined ? null : parseEventInstant(edit.start);
  const [title, setTitle] = useState(edit?.title ?? "");
  const [allDay, setAllDay] = useState(edit?.allDay ?? false);
  const [start, setStart] = useState(startTime ?? existing?.time ?? "09:00");
  const [end, setEnd] = useState(
    endTime ?? (edit?.end == null ? "" : (parseEventInstant(edit.end)?.time ?? "")),
  );
  // `-1` means "the file carries a rule this sheet cannot draw": held as absent so
  // the save leaves the line alone instead of replacing it with a simpler phrase.
  const [repeat, setRepeat] = useState(REPEAT_VALUES.indexOf(edit?.repeat ?? ""));
  const [remind, setRemind] = useState(REMIND_VALUES.indexOf(edit?.remind ?? ""));
  const [calendar, setCalendar] = useState(edit?.calendar ?? "");
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
      if (edit !== undefined) {
        await applyEventEdit({
          noteId: edit.noteId,
          rendered: { start: edit.start, end: edit.end, allDay: edit.allDay },
          next: {
            title: title.trim(),
            start: formatEventInstant(startInstant),
            end: endInstant === null ? null : formatEventInstant(endInstant),
            calendar: calendar.trim() === "" ? null : calendar.trim(),
            // `-1` is unrepresentable, and `undefined` is how the writer is told to
            // leave that line exactly as the file has it.
            repeat: repeat < 0 ? undefined : (REPEAT_VALUES[repeat] ?? ""),
            remind: remind < 0 ? undefined : (REMIND_VALUES[remind] ?? ""),
          },
          io: {
            readNote: noteRead,
            writeNote: (id: string, body: string, base: string) => noteUpdate(id, body, base),
          },
        });
      } else {
        await createEventNote({
          title: title.trim(),
          start: startInstant,
          end: endInstant,
          // Empty means "the file carries no such field", which is the absence the
          // readers treat as "one-off" and "no reminder" rather than a value.
          repeat: repeat < 0 ? null : (REPEAT_VALUES[repeat] ?? ""),
          remind: remind < 0 ? null : (REMIND_VALUES[remind] ?? ""),
          calendar: calendar.trim() === "" ? null : calendar.trim(),
        });
      }
      onCreated();
    } catch (err) {
      // A value-anchored refusal is not a bug in the sheet: the note moved under it.
      setError(
        // One failure line for both modes: the user's next move is the same either
        // way, and a second identical sentence is a string nobody can keep in step.
        err instanceof EventWriteRefused
          ? t("calendar.composer.refused")
          : t("calendar.composer.createFailed"),
      );
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }} data-testid="calendar.composer">
        <h2 style={{ margin: "var(--space-0)", fontSize: "var(--text-lg)", fontWeight: "var(--weight-semibold, 600)" }}>
          {edit === undefined ? t("calendar.composer.title") : t("common.edit")}
        </h2>

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
            active={repeat}
            onChange={setRepeat}
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
            active={remind}
            onChange={setRemind}
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
          {edit === undefined ? t("calendar.composer.create") : t("calendar.form.save")}
        </Button>
        <Button variant="ghost" onClick={onClose} data-testid="calendar.composer.cancel">
          {t("common.cancel")}
        </Button>
      </div>
    </Sheet>
  );
}
