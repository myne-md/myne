// The phone's calendar (myne-md/myne#1037, grill Q11: "all three clients,
// including a full-screen mobile calendar").
//
// # What it is, and what it deliberately is not
//
// It is a READER: a month, the days of that month, and the events on the day you
// pick. Authoring stays on the desktop, where the task-field editor already owns
// the pickers; a phone keyboard over an `.ics`-shaped record is a form to design,
// not a row to bolt on.
//
// # The math is not here
//
// `@myne/calendar-grid` owns which day an event falls on and how a month lays out,
// and it is the SAME module the desktop pane draws from. That is why a phone and a
// laptop cannot disagree about what is on Thursday: they are not two
// implementations that happen to agree, they are one function called twice.
//
// # Why the read is not bounded
//
// `bounded` is the MODEL's clamp on this query, not the user's. This screen is the
// owner looking at their own calendar, so it asks for the whole month, the same way
// the desktop pane does.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Spinner } from "../../components";
import { vaultIndicesCalendarRange } from "../../lib/calendar";
import { WEEKDAY_HEADERS, monthGrid, shiftAnchor, windowForView } from "@myne/calendar-grid";
import type { CivilDate } from "@myne/dialect-civil-date";
import type { CalendarRow } from "@myne/vault-indices";
import { monthLabel } from "@myne/calendar-format";
import { tappable } from "../a11y/tappable";

/** Today, as the civil date the calendar speaks. */
function todayCivil(): CivilDate {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() } as CivilDate;
}

export function CalendarSurface({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [anchor, setAnchor] = useState<CivilDate>(todayCivil);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<readonly CalendarRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    const window = windowForView("month", anchor, 0);
    setFailed(false);
    void vaultIndicesCalendarRange(window.start, window.end, false)
      .then((answer) => setRows(answer.rows))
      .catch(() => {
        setRows([]);
        setFailed(true);
      });
  }, [anchor]);
  useEffect(load, [load]);

  const grid = rows === null ? [] : monthGrid(anchor, rows);
  const dayRows =
    selected === null ? [] : (rows ?? []).filter((row) => row.start.slice(0, 10) === selected);

  return (
    <div
      style={{
        position: "absolute",
        inset: "var(--space-0)",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-1)",
        zIndex: "var(--z-dropdown)" as unknown as number,
      }}
      data-testid="calendar.surface"
    >
      {/* Header: month, paging, and the way out. */}
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-7) var(--space-4) var(--space-2)",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <Button
          variant="ghost"
          full={false}
          {...tappable}
          aria-label={t("calendar.prev")}
          data-testid="calendar.prev"
          onClick={() => setAnchor((a: CivilDate) => shiftAnchor("month", a, -1))}
        >
          ‹
        </Button>
        <span style={{ flex: "1 1 auto", fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold, 600)" as unknown as number }} data-testid="calendar.heading">
          {monthLabel(anchor, i18n.language)}
        </span>
        <Button
          variant="ghost"
          full={false}
          {...tappable}
          aria-label={t("calendar.next")}
          data-testid="calendar.next"
          onClick={() => setAnchor((a: CivilDate) => shiftAnchor("month", a, 1))}
        >
          ›
        </Button>
        <Button variant="ghost" full={false} {...tappable} data-testid="calendar.today" onClick={() => setAnchor(todayCivil())}>
          {t("calendar.today")}
        </Button>
        <Button variant="ghost" full={false} {...tappable} aria-label={t("calendar.close")} data-testid="calendar.close" onClick={onClose}>
          ✕
        </Button>
      </div>

      {/* Weekday headers: the same seven the grid builds rows from. */}
      <div style={{ flex: "none", display: "grid", gridTemplateColumns: "repeat(7, 1fr)", padding: "var(--space-2)" }}>
        {WEEKDAY_HEADERS.map((label) => (
          <span key={label} style={{ textAlign: "center", fontSize: "var(--text-xs)", fontWeight: "var(--weight-semibold, 600)" as unknown as number, letterSpacing: "var(--tracking-caps)", color: "var(--fg-3)", textTransform: "uppercase" }}>
            {label}
          </span>
        ))}
      </div>

      {rows === null ? (
        <div style={{ flex: "1 1 auto", display: "grid", placeItems: "center" }} data-testid="calendar.loading">
          <Spinner />
        </div>
      ) : (
        <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "var(--space-0) var(--space-2) var(--space-3)" }} data-testid="calendar.grid">
          {grid.map((week, wi) => (
            <div key={wi} style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
              {week.map((cell) => {
                const dayNumber = cell.date.slice(8, 10).replace(/^0/, "");
                const chosen = selected === cell.date;
                return (
                  <button
                    {...tappable}
                    key={cell.date}
                    onClick={() => setSelected(cell.date)}
                    data-testid={`calendar.cell.${cell.date}`}
                    aria-pressed={chosen}
                    style={{
                      minHeight: "var(--target-min)",
                      border: "none",
                      background: chosen ? "var(--accent-soft, var(--bg-3))" : "transparent",
                      color: cell.inMonth ? "var(--fg-1)" : "var(--fg-3)",
                      borderRadius: "var(--radius-2)",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: "var(--space-1)",
                      padding: "var(--space-1) var(--space-0)",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ fontSize: "var(--text-sm)" }}>{dayNumber}</span>
                    {cell.rows.length > 0 && (
                      <span
                        data-testid={`calendar.dot.${cell.date}`}
                        style={{ width: "var(--space-1)", height: "var(--space-1)", borderRadius: "var(--radius-pill)", background: "var(--accent)" }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          {/* The day you picked, below the month it belongs to. */}
          {selected !== null && (
            <div style={{ marginTop: "var(--space-3)" }} data-testid="calendar.day-list">
              {dayRows.length === 0 ? (
                <p style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }} data-testid="calendar.day-empty">
                  {t("calendar.noEvents")}
                </p>
              ) : (
                dayRows.map((row) => (
                  <div
                    key={`${row.noteId}:${row.start}`}
                    data-testid={`calendar.event.${row.noteId}`}
                    style={{ padding: "var(--space-2) var(--space-0)", borderBottom: "1px solid var(--line-1)" }}
                  >
                    <div style={{ fontSize: "var(--text-base)", fontWeight: "var(--weight-medium, 500)" as unknown as number }}>{row.title ?? t("calendar.untitled")}</div>
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                      {row.allDay ? t("calendar.allDay") : row.start.slice(11)}
                      {row.calendar === null ? "" : `  ·  ${row.calendar}`}
                      {row.conflicts ? `  ·  ${t("calendar.conflict")}` : ""}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {failed && (
        <p role="alert" style={{ flex: "none", padding: "var(--space-0) var(--space-4) var(--space-4)", fontSize: "var(--text-sm)", color: "var(--danger)" }} data-testid="calendar.error">
          {t("calendar.loadFailed")}
        </p>
      )}
    </div>
  );
}
