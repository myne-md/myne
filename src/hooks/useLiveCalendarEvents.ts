// The reminders' view of the calendar (myne-md/myne#1037, task 9).
//
// The reminder pass needs events, and events come from ONE query: the same
// `vault_indices_calendar_range` the pane renders and the mobile screen will call.
// A second reader (walking notes, parsing frontmatter per file) would be a second
// answer to "what is on Thursday", and the two would drift the first time either
// changed.
//
// **The window is the horizon, not a month.** The pass can only ever register an
// instant inside the horizon, so reading the whole schedule to compute that would be
// work nobody can use; the bound is what keeps this cheap enough to run on every
// index change.
//
// A locked vault resolves no rows and no error: the pass then has no events, and a
// reminder that cannot be scheduled is not an error to surface from a background
// loop.

import { useEffect, useState } from "react";
import {
  REMINDER_HORIZON_DAYS,
  horizonEndDate,
  type EventReminderSource,
} from "../lib/reminderSchedule";
import { vaultIndicesCalendarRange, type CalendarRow } from "../notes/vaultIndices";
import { useIndexNonce } from "../notes/indexNonce";
import { todayLocal } from "../notes/taskFilters";
import { useDateTimeDisplay } from "../lib/useDateTimeDisplay";

/** The rows the reminder pass should consider, narrowed to what it needs. */
export function useLiveCalendarEvents(horizonDays: number | null): readonly EventReminderSource[] {
  const nonce = useIndexNonce();
  const { timeZone } = useDateTimeDisplay();
  const horizon = horizonDays ?? REMINDER_HORIZON_DAYS;
  const today = todayLocal(new Date(), timeZone);
  // The horizon's last day is the window's end; both are local civil dates, and the
  // pass compares wall-clock stamps, so no offset arithmetic happens here.
  const windowEnd = horizonEndDate(new Date(), horizon);
  const [events, setEvents] = useState<readonly EventReminderSource[]>([]);

  useEffect(() => {
    let cancelled = false;
    void vaultIndicesCalendarRange(today, `${windowEnd} 23:59`, false)
      .then((answer) => {
        if (cancelled) return;
        const rows: readonly CalendarRow[] = Array.isArray(answer?.rows) ? answer.rows : [];
        setEvents(rows.map(toSource));
      })
      .catch(() => {
        if (cancelled) return;
        // Locked, or the index is not ready.
        //
        // The list is LEFT ALONE rather than cleared. The reminder pass reconciles the
        // OS against what this hook reports, so an empty list is not "nothing to
        // report", it is "cancel every event reminder", and a transient read failure
        // would then withdraw reminders that were correctly registered. The next nonce
        // or tick retries by construction, which is what makes staying inert safe.
      });
    return () => {
      cancelled = true;
    };
  }, [today, windowEnd, nonce]);

  return events;
}

function toSource(row: CalendarRow): EventReminderSource {
  return {
    noteId: row.noteId,
    start: row.start,
    allDay: row.allDay,
    occurrenceDate: row.occurrenceDate,
    // `?? null`: a row read from an older index may predate the field, and an
    // undefined lead must read as "no reminder" rather than as a crash in a
    // background pass.
    remind: row.remind ?? null,
  };
}
