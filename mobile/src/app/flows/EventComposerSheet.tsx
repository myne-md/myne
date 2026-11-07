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
import { Button, Sheet, Switch, TextField } from "../../components";
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

        <Button disabled={!canCreate} onClick={() => void create()} data-testid="calendar.composer.create">
          {t("calendar.composer.create")}
        </Button>
        <Button variant="ghost" onClick={onClose} data-testid="calendar.composer.cancel">
          {t("calendar.composer.cancel")}
        </Button>
      </div>
    </Sheet>
  );
}
