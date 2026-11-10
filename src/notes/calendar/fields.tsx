// The calendar's date, time and count fields (myne-md/myne#1037).
//
// `<input type="date">` and its siblings ignore every design token and differ
// between the three clients, so each is rebuilt here over `grid.ts` for the month
// matrix and `datetimeFormat` for what the user reads: a picker cannot disagree
// with the pane about which day is which (`decisions/clients/0801`).

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addDays,
  addMonths,
  formatCivilDate,
  parseCivilDate,
  type CivilDate,
} from "@myne/dialect/civilDate";
import { Button } from "../../components/primitives/Button";
import { IconButton } from "../../components/primitives/IconButton";
import { AnchoredPanel } from "../../components/primitives/AnchoredPanel";
import { Select } from "../../components/primitives/Select";
import { useDateTimeDisplay } from "../../lib/useDateTimeDisplay";
import type { DateTimeDisplay } from "../../lib/datetimeFormat";
import { formatCivilDate as formatStoredDate } from "@myne/editor/host/lib/datetimeFormat";
import { monthLabel } from "./format";
import { monthGrid } from "./grid";
import { useLocalToday } from "../useLocalToday";

/** The date trigger's skin; `min-width` keeps a short month name from moving the row. */
const TRIGGER_STYLE = { minWidth: "9.5em", justifyContent: "flex-start" } as const;

const PANEL_STYLE = {
  background: "var(--bg-1)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-2)",
  padding: "var(--space-2)",
} as const;

const HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  paddingBottom: "var(--space-1)",
} as const;

/** A calendar's seven columns, shared by the picker's two header rows so the
 *  caption and the cells cannot drift. */
const WEEK_STYLE = {
  display: "grid",
  gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
  gap: "var(--space-0)",
} as const;

/** One day of the month: a square a number, a ring or a fill sits in. */
function cellStyle(selected: boolean, today: boolean, inMonth = true): Record<string, string> {
  return {
    minWidth: "var(--space-0)",
    height: "var(--space-6)",
    padding: "var(--space-0)",
    justifyContent: "center",
    fontWeight: selected ? "var(--weight-medium, 500)" : "var(--weight-regular, 400)",
    color: selected ? "var(--accent-on)" : inMonth ? (today ? "var(--accent)" : "var(--fg-1)") : "var(--fg-3)",
    background: selected ? "var(--accent)" : "transparent",
    // The selection is the FILL; today is a ring, so a day that is both still
    // reads as chosen first and today second.
    outline: today && !selected ? "1px solid var(--accent)" : "none",
    outlineOffset: "-1px",
    borderRadius: "var(--radius-pill)",
  };
}

/**
 * A date, picked from a month grid.
 *
 * Keyboard: the grid is a plain focus order over its cells, arrows move a day
 * (and a week vertically) or step the month at an edge, Enter/Space picks, and
 * Escape closes. A picker that only answers a mouse is a picker half the app
 * cannot use.
 */
export function DateField({
  label,
  value,
  onChange,
  testId,
  allowEmpty = false,
}: {
  label: string;
  /** A canonical `YYYY-MM-DD`, or `null` when nothing is chosen yet. */
  value: string | null;
  onChange: (next: string | null) => void;
  testId: string;
  allowEmpty?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const display = useDateTimeDisplay();
  const today = useLocalToday(display.timeZone);
  const [open, setOpen] = useState(false);
  const selected = value === null ? null : parseCivilDate(value);
  const [month, setMonth] = useState<CivilDate>(() => selected ?? parseCivilDate(today) ?? { year: 2026, month: 1, day: 1 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dayRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // `monthGrid` takes the rows that occupy each cell; a picker has none, and
  // passing the empty list keeps the WEEK START (ISO Monday) in one place.
  const weeks = useMemo(() => monthGrid(month, []), [month]);
  const cells = useMemo(() => weeks.flat(), [weeks]);

  const shown = value === null ? "" : formatStoredDate(value, display);

  const openPicker = (): void => {
    // Opening always starts at the chosen date's month, not wherever the user
    // last browsed: the field is a question about THIS value.
    if (selected !== null) setMonth(selected);
    setOpen(true);
  };

  const pick = (date: string): void => {
    onChange(date);
    setOpen(false);
  };

  const moveFocus = (fromIndex: number, deltaDays: number): void => {
    const target = cells[fromIndex] === undefined ? null : parseCivilDate(cells[fromIndex]!.date);
    if (target === null) return;
    const next = addDays(target, deltaDays);
    const nextIndex = cells.findIndex((cell) => cell.date === formatCivilDate(next));
    if (nextIndex < 0) {
      // An arrow that walked off the grid steps the month and lands on the same
      // day number rather than doing nothing, which is what a month grid implies.
      setMonth({ year: next.year, month: next.month, day: 1 });
      return;
    }
    dayRefs.current[nextIndex]?.focus();
  };

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        icon="calendar"
        style={TRIGGER_STYLE}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={testId}
        // Unformatted, so a test or a scenario does not depend on the user's
        // date-format preference. The cells carry `data-date` for the same reason.
        data-value={value ?? ""}
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        {shown === "" ? t("common.nodate") : shown}
      </Button>
      <AnchoredPanel
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        // Under the field: the default `end` hangs a 252px panel to the LEFT of it.
        align="start"
        minWidth={252}
        style={PANEL_STYLE}
      >
        <div role="dialog" aria-label={label}>
          <div style={HEADER_STYLE}>
            <IconButton
              icon="chevron-left"
              label={t("calendar.prev")}
              iconSize={13}
              onClick={() => setMonth(addMonths(month, -1))}
            />
            <span style={{ flex: "1 1 auto", textAlign: "center", fontSize: "var(--text-sm)", color: "var(--fg-1)" }}>
              {monthLabel(month, i18n.language)}
            </span>
            <IconButton
              icon="chevron-right"
              label={t("calendar.next")}
              iconSize={13}
              onClick={() => setMonth(addMonths(month, 1))}
            />
          </div>
          <div style={WEEK_STYLE} aria-hidden="true">
            {weeks.length > 0 &&
              weeks[0]!.map((cell) => {
                const date = parseCivilDate(cell.date);
                return (
                  <span
                    key={`h-${cell.date}`}
                    style={{ textAlign: "center", fontSize: "var(--text-xs)", color: "var(--fg-3)" }}
                  >
                    {date === null
                      ? ""
                      : new Intl.DateTimeFormat(i18n.language, { weekday: "narrow", timeZone: "UTC" }).format(
                          new Date(Date.UTC(date.year, date.month - 1, date.day)),
                        )}
                  </span>
                );
              })}
          </div>
          <div style={WEEK_STYLE}>
            {cells.map((cell, index) => {
              const date = parseCivilDate(cell.date);
              const isSelected = value !== null && value === cell.date;
              const isToday = cell.date === today;
              return (
                <Button
                  key={cell.date}
                  ref={(el) => {
                    dayRefs.current[index] = el;
                  }}
                  variant="ghost"
                  style={cellStyle(isSelected, isToday, cell.inMonth)}
                  aria-label={date === null ? cell.date : new Intl.DateTimeFormat(i18n.language, {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                    timeZone: "UTC",
                  }).format(new Date(Date.UTC(date.year, date.month - 1, date.day)))}
                  aria-current={isToday ? "date" : undefined}
                  data-testid={`${testId}-day`}
                  data-date={cell.date}
                  data-selected={isSelected ? "true" : "false"}
                  onClick={() => pick(cell.date)}
                  onKeyDown={(event) => {
                    switch (event.key) {
                      case "ArrowLeft":
                        event.preventDefault();
                        moveFocus(index, -1);
                        return;
                      case "ArrowRight":
                        event.preventDefault();
                        moveFocus(index, 1);
                        return;
                      case "ArrowUp":
                        event.preventDefault();
                        moveFocus(index, -7);
                        return;
                      case "ArrowDown":
                        event.preventDefault();
                        moveFocus(index, 7);
                        return;
                      default:
                        return;
                    }
                  }}
                >
                  {String(Number(cell.date.slice(8)))}
                </Button>
              );
            })}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", paddingTop: "var(--space-1)" }}>
            <Button
              variant="ghost"
              data-testid={`${testId}-today`}
              onClick={() => {
                setMonth(parseCivilDate(today) ?? month);
                pick(today);
              }}
            >
              {t("common.today")}
            </Button>
            <span style={{ flex: "1 1 auto" }} />
            {allowEmpty && value !== null && (
              <Button
                variant="ghost"
                data-testid={`${testId}-clear`}
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                {t("common.clear")}
              </Button>
            )}
          </div>
        </div>
      </AnchoredPanel>
    </>
  );
}

/** The minutes a picker offers: every five, plus whatever the value already
 *  carries, so a note written by hand as `09:07` is not silently rounded by
 *  opening its own field. */
function minuteOptions(current: string | null): readonly string[] {
  const out: string[] = [];
  for (let m = 0; m < 60; m += 5) out.push(String(m).padStart(2, "0"));
  const carried = current?.split(":")[1];
  if (carried !== undefined && !out.includes(carried)) {
    out.push(carried);
    out.sort();
  }
  return out;
}

const HOUR_VALUES = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));

/** `9 AM` / `09` - the hour alone, because `formatWallClockTime` always prints
 *  minutes and `9:00 AM : 30` is not a clock. Same three modes it switches on, so
 *  the two cannot disagree about 12 versus 24. */
function hourLabel(hour: string, display: DateTimeDisplay): string {
  const h = Number(hour);
  if (display.timeFormat === "24h") return hour;
  if (display.timeFormat === "12h") return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
  return new Intl.DateTimeFormat(display.locale, { hour: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(2000, 0, 1, h)),
  );
}

/**
 * A wall-clock time, from two of the app's own dropdowns.
 *
 * Wall clock, not an instant (`markdown-dialect.md` §3.10.2): `09:00` means 09:00
 * wherever the note is read. The stored 24 hours are labelled in the reader's own
 * clock, so a 12-hour reader picks `2:00 PM` and the file keeps `14:00`.
 *
 * Two `Select`s, INLINE, replacing a popover of two scrolling number columns. A
 * `Select` inside an `AnchoredPanel` opens its menu in a portal, where the panel's
 * outside-click handler closes the panel on the very click meant to choose.
 */
export function TimeField({
  label,
  value,
  onChange,
  testId,
  allowEmpty = true,
}: {
  label: string;
  value: string | null;
  onChange: (next: string | null) => void;
  testId: string;
  allowEmpty?: boolean;
}) {
  const { t } = useTranslation();
  const display = useDateTimeDisplay();
  const hour = value?.slice(0, 2) ?? "09";
  const minute = value?.slice(3, 5) ?? "00";
  const hours = HOUR_VALUES.map((h) => ({ value: h, label: hourLabel(h, display) }));
  const minutes = minuteOptions(value).map((m) => ({ value: m, label: m }));

  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      // The canonical value, unformatted, for the same reason the date field's
      // trigger carries it: the labels follow the time-format preference.
      data-value={value ?? ""}
      style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}
    >
      <Select
        aria-label={t("calendar.form.hour")}
        value={hour}
        options={hours}
        onChange={(next) => onChange(`${next}:${minute}`)}
        testId={`${testId}-hour`}
        style={{ minWidth: "6.5em" }}
      />
      <span aria-hidden="true" style={{ color: "var(--fg-3)" }}>
        :
      </span>
      <Select
        aria-label={t("calendar.form.minute")}
        value={minute}
        options={minutes}
        onChange={(next) => onChange(`${hour}:${next}`)}
        testId={`${testId}-minute`}
      />
      {allowEmpty && value !== null && (
        <IconButton
          icon="x"
          label={t("common.clear")}
          iconSize={12}
          testId={`${testId}-clear`}
          onClick={() => onChange(null)}
        />
      )}
    </div>
  );
}

/**
 * A small whole number with a stepper, for the repeat rules.
 *
 * `<input type="number">` brings the platform's spinner, its own invalid states
 * and a locale-dependent separator. A count is 1..99, so a pair of buttons around
 * the value says everything it did, in the app's own chrome.
 */
export function CountField({
  label,
  value,
  min,
  max,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const clamp = (next: number): number => Math.max(min, Math.min(max, next));
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}
      role="group"
      aria-label={label}
      data-testid={testId}
    >
      <IconButton
        icon="minus"
        label={t("calendar.form.decrease", { label })}
        iconSize={13}
        bordered
        disabled={value <= min}
        testId={`${testId}-decrease`}
        onClick={() => onChange(clamp(value - 1))}
      />
      <span
        aria-live="polite"
        style={{ minWidth: "2.5em", textAlign: "center", fontSize: "var(--text-sm)", color: "var(--fg-1)" }}
        data-testid={`${testId}-value`}
      >
        {value}
      </span>
      <IconButton
        icon="plus"
        label={t("calendar.form.increase", { label })}
        iconSize={13}
        bordered
        disabled={value >= max}
        testId={`${testId}-increase`}
        onClick={() => onChange(clamp(value + 1))}
      />
    </div>
  );
}
