// The event form's model (myne-md/myne#1037, task 7).
//
// A complete event must be authorable without touching frontmatter, and the
// hard part of that is not the widgets: it is that the FORM and the NOTE have to
// stay the same record. So the model lives here as data in and data out, and the
// React surface below is a renderer over it. The tests drive the model, which is
// why they can assert a round trip through the real bytes.
//
// **The rule is chosen, never typed.** `repeat` is a structured `RecurrenceRule`
// and the emitted string comes from `formatRecurrenceRule`; the control offers
// the closed vocabulary (`INTERVAL_UNITS`, `WEEKDAYS`, `ORDINALS`). A free-text
// rule field would be a parser in a text box, and §3.8.7's vocabulary is closed
// precisely so that "every other blue moon" reads as unread rather than as
// something Myne quietly approximated.
//
// **"All day" is the ABSENCE of a time**, not a flag: that is what the file
// carries (§3.10.2), so the control says it once, in one place, and the emitted
// value is a bare date.
//
// Refusals name the field that has to change and never reach the vault:
//
// - an end before the start (`end-before-start`);
// - a reminder lead beyond the tier's horizon (`lead-beyond-horizon`), stated
//   WITH the horizon, because "too long" is not actionable and "7 days is the
//   limit" is.

import { useCallback, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCivilDate } from "@myne/dialect/civilDate";
import {
  ORDINALS,
  INTERVAL_UNITS,
  WEEKDAYS,
  formatRecurrenceRule,
  parseRecurrenceRule,
  type RecurrenceRule,
  type Weekday,
} from "@myne/dialect/recurrence";
import {
  parseEventInstant,
  parseReminderLead,
  type EventInstant,
} from "@myne/dialect/event";
import { Button } from "../../components/primitives/Button";
import { IconButton } from "../../components/primitives/IconButton";
import { Input } from "../../components/primitives/Input";
import { ModalShell } from "../../components/primitives/ModalShell";
import { Segmented } from "../../components/primitives/Segmented";
import { Select } from "../../components/primitives/Select";
import { CountField, DateField, TimeField } from "../calendar/fields";
import { REMINDER_HORIZON_DAYS } from "../../lib/reminderSchedule";
import { createEvent, type NewEventInput } from "../createEvent";

/**
 * The two `Select` values the calendar row owns.
 *
 * Prefixed rather than raw, because a calendar name is user text and the empty
 * string is what "no calendar" already means: `c:Work` cannot collide with that
 * option, and the branch that reads it slices by the prefix's own length.
 */
const NO_CALENDAR = "";
const CALENDAR_PREFIX = "c:";

/**
 * A chosen reminder lead: the bytes plus their length.
 *
 * Deliberately narrower than the reader's `ReminderLead`, whose `beyondHorizon`
 * is an annotation the READ adds once it knows the caller's horizon. A form does
 * not have a horizon yet, so carrying that flag here would be a second place for
 * it to be wrong.
 */
export type ReminderChoice = { readonly raw: string; readonly minutes: number };

/** What the form holds: strings and structured values, never a raw rule string. */
export type EventFormValues = {
  readonly title: string;
  readonly startDate: string;
  /** `HH:MM`, or `null` for an all-day event. */
  readonly startTime: string | null;
  /** A multi-day span's last day, or `null` for a single day. */
  readonly endDate: string | null;
  readonly endTime: string | null;
  readonly calendar: string | null;
  readonly repeat: RecurrenceRule | null;
  readonly remind: ReminderChoice | null;
  /** The note carries a `repeat:`/`remind:` this control cannot represent (a
   *  hand-written `1w`). The writer must leave that line ALONE: `null` deletes it. */
  readonly repeatUntouched?: boolean;
  readonly remindUntouched?: boolean;
};

/** Which field failed, and why. `field` is what the surface focuses. */
export type EventFormRefusal = {
  readonly field: "title" | "start" | "end" | "calendar" | "remind";
  readonly reason:
    | "title-required"
    | "start-unreadable"
    | "end-before-start"
    | "calendar-required"
    | "lead-beyond-horizon";
  /** Present for `lead-beyond-horizon`, so the message can state the limit. */
  readonly horizonDays?: number;
};

export type EventFormPlan =
  | { readonly ok: true; readonly input: NewEventInput }
  | { readonly ok: false; readonly refusal: EventFormRefusal };

/** An empty form for `date`, which is what a click on a cell opens. The calendar
 *  is seeded from the vault's own list, because a NEW event must carry one
 *  (owner, 2026-11-11). */
export function emptyEventForm(date: string, calendar: string | null = null): EventFormValues {
  return {
    title: "",
    startDate: date,
    startTime: null,
    endDate: null,
    endTime: null,
    calendar,
    repeat: null,
    remind: null,
  };
}

/** The form's values for an event the note already carries. */
export function formFromEvent(
  event: {
    readonly start: EventInstant;
    readonly end: EventInstant | null;
    readonly calendar: string | null;
    readonly repeatRaw: string | null;
    readonly remind: ReminderChoice | null;
  },
  title: string,
): EventFormValues {
  const repeat = event.repeatRaw === null ? null : parseRepeat(event.repeatRaw);
  return {
    title,
    startDate: formatCivilDate(event.start.date),
    startTime: event.start.time,
    endDate: event.end === null ? null : formatCivilDate(event.end.date),
    endTime: event.end === null ? null : event.end.time,
    calendar: event.calendar,
    repeat,
    // Rebuilt rather than passed through: the reader's lead carries a
    // `beyondHorizon` computed against ITS horizon, and a form value must not
    // carry an annotation that a caller's horizon could contradict.
    remind: event.remind === null ? null : { raw: event.remind.raw, minutes: event.remind.minutes },
  };
}

/** Parse a stored rule into the structured value the control shows. */
function parseRepeat(raw: string): RecurrenceRule | null {
  const parsed = parseRecurrenceRule(raw);
  return parsed.ok ? parsed.rule : null;
}

/** The form's values for a row the calendar is already showing, read from the
 *  emitted forms rather than by interpreting the vocabulary a second time. */
export function formFromRow(row: {
  readonly title: string | null;
  readonly start: string;
  readonly end?: string | null;
  readonly calendar?: string | null;
  readonly repeat?: string | null;
  readonly remind?: string | null;
}): EventFormValues {
  const start = parseEventInstant(row.start);
  const end = row.end == null ? null : parseEventInstant(row.end);
  // `== null`: a row from an older host carries `undefined` here.
  const repeat = row.repeat == null ? null : parseRepeat(row.repeat);
  const remind = row.remind == null ? null : parseReminderLead(row.remind);
  return {
    title: row.title ?? "",
    startDate: start === null ? row.start.slice(0, 10) : formatCivilDate(start.date),
    startTime: start === null ? null : start.time,
    endDate: end === null ? null : formatCivilDate(end.date),
    endTime: end === null ? null : end.time,
    calendar: row.calendar ?? null,
    repeat,
    remind,
    repeatUntouched: row.repeat != null && repeat === null,
    remindUntouched: row.remind != null && remind === null,
  };
}

/** The instant a form's date and optional time denote, or `null`. */
function instantOf(date: string, time: string | null): EventInstant | null {
  return parseEventInstant(time === null ? date : `${date} ${time}`);
}

/**
 * Turn the form into the record the writer takes, or name the field to fix.
 *
 * The horizon is a parameter with the tier's own default so a caller (a test, a
 * future server) can state its own without editing this module, the same
 * discipline `readEventFromFmBody`'s options follow.
 *
 * `requireCalendar` is the CREATE rule (owner, 2026-11-11: "calendaari olmayan bir
 * event olusturulamamali"), off by default so an EXISTING event that carries no
 * calendar stays editable: a hand-written note is not a record to refuse.
 */
export function planEventForm(
  values: EventFormValues,
  horizonDays: number = REMINDER_HORIZON_DAYS,
  options: { readonly requireCalendar?: boolean } = {},
): EventFormPlan {
  const title = values.title.trim();
  if (title === "") return { ok: false, refusal: { field: "title", reason: "title-required" } };

  if (options.requireCalendar === true && (values.calendar === null || values.calendar === "")) {
    return { ok: false, refusal: { field: "calendar", reason: "calendar-required" } };
  }

  const start = instantOf(values.startDate, values.startTime);
  if (start === null) return { ok: false, refusal: { field: "start", reason: "start-unreadable" } };

  let end: EventInstant | null = null;
  if (values.endDate !== null) {
    // The end's time follows the start's: an all-day event ends at the end of its
    // last day, never at an hour nobody chose, and a timed one with no hour of its
    // own ends when the start does - which is what the field prints for it.
    end = instantOf(
      values.endDate,
      values.startTime === null ? null : (values.endTime ?? values.startTime),
    );
    if (end === null) return { ok: false, refusal: { field: "end", reason: "end-before-start" } };
    if (compareInstants(end, start) < 0) {
      return { ok: false, refusal: { field: "end", reason: "end-before-start" } };
    }
  }

  if (values.remind !== null && values.remind.minutes > horizonDays * 1440) {
    return {
      ok: false,
      refusal: { field: "remind", reason: "lead-beyond-horizon", horizonDays },
    };
  }

  return {
    ok: true,
    input: {
      title,
      start,
      end,
      calendar: values.calendar,
      repeat:
        values.repeatUntouched === true
          ? undefined
          : values.repeat === null
            ? null
            : formatRecurrenceRule(values.repeat),
      remind:
        values.remindUntouched === true
          ? undefined
          : values.remind === null
            ? null
            : values.remind.raw,
    },
  };
}

function compareInstants(a: EventInstant, b: EventInstant): number {
  const key = (instant: EventInstant) =>
    `${formatCivilDate(instant.date)} ${instant.time ?? "00:00"}`;
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

/**
 * The relative leads the control offers. **One minute is the floor**: that is the
 * grammar's own (`parseReminderLead` refuses a count below 1), and an option the
 * writer cannot express silently becomes "no reminder". `tests/notes/calendarForm.test.ts`
 * parses every entry here so a future addition cannot reintroduce one.
 */
export const LEAD_CHOICES: readonly string[] = ["1m", "10m", "30m", "1h", "2h", "1d", "2d", "7d"];

function plusHour(time: string): string {
  const minutes = Math.min(23 * 60 + 59, Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * The event form.
 *
 * One writer: `createEvent`, the same function a click on a cell calls, so the
 * fast path and the full path produce the same record rather than two shapes that
 * almost agree.
 */
export function CalendarEventForm({
  initial,
  calendars = [],
  mode = "create",
  onSubmit,
  onOpenNote,
  onClose,
}: {
  readonly initial: EventFormValues;
  /** Both modes write through the same plan, so an edit cannot produce a record
   *  a create would not. */
  readonly mode?: "create" | "edit";
  readonly onSubmit?: (values: EventFormValues) => Promise<void> | void;
  /** The calendar names the vault knows: the ones with a colour, plus the ones an
   *  event already carries. The form offers these rather than a free-text box, so a
   *  typo cannot invent a seventh calendar nobody assigned a colour to. */
  readonly calendars?: readonly string[];
  /** Opens the markdown note the event is. Edit mode only: a create has none. */
  readonly onOpenNote?: () => void;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<EventFormValues>(initial);
  const [refusal, setRefusal] = useState<EventFormRefusal | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();

  const patch = useCallback((next: Partial<EventFormValues>) => {
    setValues((current) => ({ ...current, ...next }));
    setRefusal(null);
  }, []);

  const submit = useCallback(async () => {
    const current = planEventForm(values, REMINDER_HORIZON_DAYS, {
      requireCalendar: mode === "create",
    });
    if (!current.ok) {
      setRefusal(current.refusal);
      return;
    }
    setBusy(true);
    try {
      if (onSubmit !== undefined) await onSubmit(values);
      else await createEvent(current.input);
      onClose();
    } finally {
      setBusy(false);
    }
  }, [values, onSubmit, onClose]);

  const allDay = values.startTime === null;

  const removeEnd = useCallback(() => patch({ endDate: null, endTime: null }), [patch]);

  // An end equal to the start draws nothing; the offer seeds an hour later.
  const addEnd = useCallback(
    () =>
      patch({
        endDate: values.startDate,
        endTime: allDay ? null : plusHour(values.startTime ?? "09:00"),
      }),
    [patch, values.startDate, values.startTime, allDay],
  );

  // The clock coming back has to reach the END too: a `null` there is midnight.
  const setAllDay = useCallback(
    (next: string) => {
      if (next === "all-day") {
        patch({ startTime: null, endTime: null });
        return;
      }
      const startTime = values.startTime ?? "09:00";
      patch({
        startTime,
        ...(values.endDate === null ? {} : { endTime: values.endTime ?? plusHour(startTime) }),
      });
    },
    [patch, values.startTime, values.endDate, values.endTime],
  );

  const repeatKind = values.repeat === null ? "never" : values.repeat.kind;
  const ordinal = values.repeat?.kind === "ordinal" ? values.repeat : null;
  const repeatOptions = [
    { value: "never", label: t("calendar.form.repeatNever") },
    { value: "interval", label: t("calendar.form.repeatInterval") },
    { value: "weekdays", label: t("calendar.form.repeatWeekdays") },
    { value: "dayOfMonth", label: t("calendar.form.repeatDayOfMonth") },
    // A rule the picker cannot CREATE but can EDIT - and printed "Never" without it.
    ...(ordinal === null
      ? []
      : [
          {
            value: "ordinal",
            label: t("recurrence.ordinalOfMonth", {
              ordinal: t(`recurrence.ordinal.${ordinal.ordinal}`),
              weekday: t(`recurrence.weekday.${ordinal.weekday}`),
            }),
          },
        ]),
  ];

  return (
    <ModalShell
      open
      width={520}
      title={t(mode === "edit" ? "calendar.form.editTitle" : "calendar.form.title")}
      labelId={titleId}
      onClose={onClose}
      testId="calendar.form"
    >
      <div className="myne-event-form">
        <label htmlFor={titleId} className="myne-event-form__label">
          {t("calendar.form.eventTitle")}
        </label>
        <div className="myne-event-form__controls">
          <Input
            id={titleId}
            style={{ flex: "1 1 auto" }}
            value={values.title}
            onChange={(event) => patch({ title: event.target.value })}
            invalid={refusal?.field === "title"}
            aria-invalid={refusal?.field === "title" ? true : undefined}
          />
          {refusal?.field === "title" && (
            <p role="alert" className="myne-event-form__alert">
              {t("calendar.form.titleRequired")}
            </p>
          )}
        </div>

        <span className="myne-event-form__label">{t("calendar.form.starts")}</span>
        <div className="myne-event-form__controls myne-event-form__controls--stacked">
          <div className="myne-event-form__line">
            {/* Every control here is the app's own (myne-md/myne#1037): the
                platform's widgets ignore the tokens. */}
            <DateField
              label={t("calendar.form.startDate")}
              value={values.startDate}
              onChange={(next) => {
                if (next !== null) patch({ startDate: next });
              }}
              testId="calendar.form.startDate"
            />
            {!allDay && (
              <TimeField
                label={t("calendar.form.startTime")}
                value={values.startTime}
                onChange={(next) => patch({ startTime: next })}
                testId="calendar.form.startTime"
                allowEmpty={false}
              />
            )}
          </div>
          {/* Under the pair it modifies: wrapping in ONE state moves the target. */}
          <Segmented
            ariaLabel={t("calendar.form.allDay")}
            size="sm"
            value={allDay ? "all-day" : "timed"}
            options={[
              { value: "all-day", label: t("calendar.form.allDay") },
              { value: "timed", label: t("calendar.form.timed") },
            ]}
            onChange={setAllDay}
            testId="calendar.form.allDayToggle"
          />
        </div>

        <span className="myne-event-form__label">{t("calendar.form.ends")}</span>
        <div className="myne-event-form__controls">
          {values.endDate === null ? (
            <Button variant="ghost" icon="plus" data-testid="calendar.form.endAdd" onClick={addEnd}>
              {t("calendar.form.addEnd")}
            </Button>
          ) : (
            <>
              <DateField
                label={t("calendar.form.endDate")}
                value={values.endDate}
                onChange={(next) => {
                  if (next !== null) patch({ endDate: next });
                }}
                testId="calendar.form.endDate"
              />
              {!allDay && (
                <TimeField
                  label={t("calendar.form.endTime")}
                  value={values.endTime ?? values.startTime}
                  onChange={(next) => patch({ endTime: next })}
                  testId="calendar.form.endTime"
                  allowEmpty={false}
                />
              )}
              <IconButton
                icon="x"
                label={t("calendar.form.clearEnd")}
                iconSize={12}
                testId="calendar.form.endClear"
                onClick={removeEnd}
              />
            </>
          )}
          {refusal?.field === "end" && (
            <p role="alert" className="myne-event-form__alert">
              {t("calendar.form.endBeforeStart")}
            </p>
          )}
        </div>

        <span className="myne-event-form__label">{t("calendar.form.calendarLabel")}</span>
        <div className="myne-event-form__controls">
          {/* A vault with no calendar yet gets a NAME field instead of an empty
              menu: an event must belong to a calendar (owner, 2026-11-11) and zero
              options would make that rule impossible to satisfy here. */}
          {calendars.length === 0 && mode === "create" ? (
            <Input
              aria-label={t("calendar.form.calendarLabel")}
              placeholder={t("calendar.form.calendarPlaceholder")}
              value={values.calendar ?? ""}
              onChange={(event) => patch({ calendar: event.target.value === "" ? null : event.target.value })}
              invalid={refusal?.field === "calendar"}
              aria-invalid={refusal?.field === "calendar" ? true : undefined}
              data-testid="calendar.form.calendarName"
              style={{ minWidth: "12.5em" }}
            />
          ) : (
            <Select
              aria-label={t("calendar.form.calendarLabel")}
              value={values.calendar === null ? NO_CALENDAR : CALENDAR_PREFIX + values.calendar}
              options={[
                // "No calendar" is offered only where it can be kept: on an event
                // that already has none. A create always belongs to one, so the
                // empty option there would be a choice the form then refuses.
                ...(mode === "edit" ? [{ value: NO_CALENDAR, label: t("calendar.form.noCalendar") }] : []),
                // The row's own name first when the vault does not know it (a note
                // hand-written elsewhere), so opening this form cannot silently
                // reassign an event to a different calendar.
                ...(values.calendar !== null && !calendars.includes(values.calendar)
                  ? [{ value: CALENDAR_PREFIX + values.calendar, label: values.calendar }]
                  : []),
                ...calendars.map((name) => ({ value: CALENDAR_PREFIX + name, label: name })),
              ]}
              onChange={(chosen) =>
                patch({ calendar: chosen === NO_CALENDAR ? null : chosen.slice(CALENDAR_PREFIX.length) })
              }
              testId="calendar.form.calendar"
              style={{ minWidth: "12.5em" }}
            />
          )}
          {refusal?.field === "calendar" && (
            <p role="alert" className="myne-event-form__alert" data-testid="calendar.form.calendarAlert">
              {t("calendar.form.calendarRequired")}
            </p>
          )}
        </div>

        <span className="myne-event-form__label myne-event-form__group">
          {t("calendar.form.repeat")}
        </span>
        <div className="myne-event-form__controls myne-event-form__group">
          <Select
            aria-label={t("calendar.form.repeat")}
            value={repeatKind}
            options={repeatOptions}
            onChange={(next) => patch({ repeat: defaultRuleFor(next), repeatUntouched: false })}
            testId="calendar.form.repeatKind"
            style={{ minWidth: "15em" }}
          />
          {values.repeat?.kind === "interval" && (
            <>
              <CountField
                label={t("calendar.form.repeatCount")}
                value={values.repeat.count}
                min={1}
                max={99}
                testId="calendar.form.repeatCount"
                onChange={(count) =>
                  patch({
                    repeat: {
                      kind: "interval",
                      unit: values.repeat?.kind === "interval" ? values.repeat.unit : "week",
                      count,
                    },
                  })
                }
              />
              <Select
                aria-label={t("calendar.form.repeatUnit")}
                value={values.repeat.unit}
                options={INTERVAL_UNITS.map((unit) => ({ value: unit, label: t(`calendar.form.unit.${unit}`) }))}
                onChange={(unit) =>
                  patch({
                    repeat: {
                      kind: "interval",
                      unit: unit as (typeof INTERVAL_UNITS)[number],
                      count: values.repeat?.kind === "interval" ? values.repeat.count : 1,
                    },
                  })
                }
              />
            </>
          )}
          {values.repeat?.kind === "weekdays" && (
            <Select
              aria-label={t("calendar.form.repeatWeekday")}
              value={values.repeat.days[0] ?? "monday"}
              options={WEEKDAYS.map((day) => ({ value: day, label: t(`calendar.weekdayLong.${day}`) }))}
              onChange={(day) => patch({ repeat: { kind: "weekdays", days: [day as Weekday] } })}
            />
          )}
          {values.repeat?.kind === "dayOfMonth" && (
            <>
              <CountField
                label={t("calendar.form.repeatDay")}
                // A "last day" rule has no number to step; stepping makes it
                // numbered again, which is what the button beside it does anyway.
                value={values.repeat.day === "last" ? 31 : values.repeat.day}
                min={1}
                max={31}
                testId="calendar.form.repeatDay"
                onChange={(day) => patch({ repeat: { kind: "dayOfMonth", day } })}
              />
              <Button
                variant="ghost"
                onClick={() => patch({ repeat: { kind: "dayOfMonth", day: "last" } })}
              >
                {t("calendar.form.repeatLastDay")}
              </Button>
            </>
          )}
          {values.repeat?.kind === "ordinal" && (
            <>
              <Select
                aria-label={t("calendar.form.repeatOrdinal")}
                value={values.repeat.ordinal}
                options={ORDINALS.map((ordinal) => ({ value: ordinal, label: t(`calendar.form.ordinal.${ordinal}`) }))}
                onChange={(ordinal) =>
                  patch({
                    repeat: {
                      kind: "ordinal",
                      ordinal: ordinal as (typeof ORDINALS)[number],
                      weekday: values.repeat?.kind === "ordinal" ? values.repeat.weekday : "monday",
                    },
                  })
                }
              />
              <Select
                aria-label={t("calendar.form.repeatWeekday")}
                value={values.repeat.weekday}
                options={WEEKDAYS.map((day) => ({ value: day, label: t(`calendar.weekdayLong.${day}`) }))}
                onChange={(day) =>
                  patch({
                    repeat: {
                      kind: "ordinal",
                      ordinal: values.repeat?.kind === "ordinal" ? values.repeat.ordinal : "first",
                      weekday: day as Weekday,
                    },
                  })
                }
              />
            </>
          )}
        </div>

        <span className="myne-event-form__label">{t("calendar.form.remindLabel")}</span>
        <div className="myne-event-form__controls">
          <Select
            aria-label={t("calendar.form.remind", { days: REMINDER_HORIZON_DAYS })}
            value={values.remind?.raw ?? "none"}
            options={[
              { value: "none", label: t("calendar.form.remindNone") },
              ...LEAD_CHOICES.map((lead) => ({ value: lead, label: t(`calendar.form.lead.${lead}`) })),
            ]}
            onChange={(lead) =>
              patch({
                remind: lead === "none" ? null : (parseReminderLead(lead) ?? null),
                remindUntouched: false,
              })
            }
            testId="calendar.form.remind"
            style={{ minWidth: "12.5em" }}
          />
          {refusal?.field === "remind" && (
            <p role="alert" className="myne-event-form__alert">
              {t("calendar.form.leadBeyondHorizon", { days: refusal.horizonDays ?? REMINDER_HORIZON_DAYS })}
            </p>
          )}
        </div>

        <div className="myne-event-form__footer">
          {mode === "edit" && onOpenNote !== undefined ? (
            <Button
              variant="ghost"
              onClick={onOpenNote}
              data-testid="calendar.form.openNote"
              style={{ marginInlineEnd: "auto" }}
            >
              {t("calendar.form.openNote")}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()} data-testid="calendar.form.save">
            {t("calendar.form.save")}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

/** The rule a freshly chosen kind starts with, so the control is never empty. */
function defaultRuleFor(kind: string): RecurrenceRule | null {
  switch (kind) {
    case "interval":
      return { kind: "interval", unit: "week", count: 1 };
    case "weekdays":
      return { kind: "weekdays", days: ["monday"] };
    case "dayOfMonth":
      return { kind: "dayOfMonth", day: 1 };
    case "ordinal":
      return { kind: "ordinal", ordinal: "first", weekday: "monday" };
    default:
      return null;
  }
}
