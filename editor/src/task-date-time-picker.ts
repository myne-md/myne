// Myne-owned date + time picker for the task-field editor (myne-md/myne#614).
//
// Replaces the platform `<input type="date">` / `<input type="time">` that the
// due / remind field used to build. A platform input renders in the WebView's
// own region format (`08/01/2026`, `12:30 PM`), which the page cannot read or
// change, so the popup disagreed with the chip and the Tasks panel behind it and
// looked different on every WebView. This control prints in the user's chosen
// `date_format` / `time_format` and draws months, weekdays and the AM/PM label
// from `Intl`, so all three clients and all 32 languages agree by construction.
//
// **The stored shape does not change.** The calendar produces the same
// `YYYY-MM-DD` (optionally ` HH:mm`) civil date the platform input produced, and
// this module never touches a zone: a note time is local wall clock, so the
// picker must not convert (dialect §3.6.4). A stored seconds component was
// already dropped by the platform time input and is still dropped, so a value
// that reached the old control unchanged reaches this one unchanged. `getValue`
// returns `""` when no day is chosen, because a bare time is not a
// `TaskInstant`.
//
// No new dependency: the grid is hand-rolled, per `CLAUDE.md`'s minimal
// direct-dependency commitment and the module header that first chose the
// platform input for exactly that reason (a decision this change reverses, with
// a `design-notes/` entry naming what changed since that measurement).
//
// Keyboard reachable from day one, because chips never open on caret entry and
// this is the only editor for these values in live mode: day cells use a roving
// tabindex with arrow keys (arrows move a day, PageUp/Down a month, Home/End a
// week), the hour/minute controls are ARIA spinbuttons, and Enter/Escape are
// handled by the surface's modal skeleton.

import i18n from "./i18n";
import {
  type DateTimeDisplay,
  dateTimeDisplay,
  formatCivilDate,
  splitStoredValue,
  todayIn,
} from "./host/lib/datetimeFormat";

export interface TaskDateTimeControl {
  readonly root: HTMLElement;
  readonly getValue: () => string;
  readonly focusTarget: HTMLElement;
}

const DAY_MS = 86_400_000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isoOf(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  return `${y}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function dateOf(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function shiftDays(iso: string, days: number): string {
  const d = dateOf(iso);
  return d === null ? iso : isoOf(new Date(d.getTime() + days * DAY_MS));
}

/** Shift by calendar months, clamping the day for short months (`2026-01-31` →
 *  `2026-02-28`, not `2026-03-03`). */
function shiftMonths(iso: string, months: number): string {
  const d = dateOf(iso);
  if (d === null) return iso;
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const daysInTarget = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const day = Math.min(d.getUTCDate(), daysInTarget);
  return isoOf(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), day)));
}

/** The locale's first day of the week, in `Date.getUTCDay()` terms
 *  (`0` = Sunday). `Intl.Locale`'s week info is the only correct source; older
 *  runtimes fall back to Monday, the ISO default the rest of Myne uses. */
function firstWeekday(locale: string): number {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      weekInfo?: { firstDay?: number };
      getWeekInfo?: () => { firstDay?: number };
    };
    const info =
      typeof loc.getWeekInfo === "function" ? loc.getWeekInfo() : loc.weekInfo;
    if (info !== undefined && typeof info.firstDay === "number") {
      return info.firstDay % 7;
    }
  } catch {
    // No `Intl.Locale` week info on this runtime, so fall through.
  }
  return 1;
}

function weekdayLabels(locale: string, first: number): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const labels: string[] = [];
  // 2024-01-07 is a Sunday (getUTCDay 0), so Jan 7 + getUTCDay is that weekday.
  for (let i = 0; i < 7; i += 1) {
    labels.push(fmt.format(new Date(Date.UTC(2024, 0, 7 + ((first + i) % 7)))));
  }
  return labels;
}

function monthLabel(locale: string, year: number, month0: number): string {
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    // A civil month name must not depend on the host zone: formatting a
    // UTC-midnight probe in a zone west of UTC lands on the previous day and
    // prints the wrong month (the off-by-one the shared module warns about).
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month0, 1)));
}

/** The locale's AM/PM (or equivalent) labels, derived rather than hard-coded so
 *  an Arabic or CJK locale gets its own day-period words. */
function meridiem(locale: string, pm: boolean): string {
  const parts = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    hour12: true,
    // Anchored in UTC so the answer does not depend on the machine's zone: a
    // 21:00 UTC probe is "PM" everywhere.
    timeZone: "UTC",
  }).formatToParts(new Date(Date.UTC(2024, 0, 1, pm ? 21 : 9)));
  return parts.find((p) => p.type === "dayPeriod")?.value ?? (pm ? "PM" : "AM");
}

function usesHour12(display: DateTimeDisplay): boolean {
  if (display.timeFormat === "24h") return false;
  if (display.timeFormat === "12h") return true;
  return (
    new Intl.DateTimeFormat(display.locale, { hour: "numeric" }).resolvedOptions()
      .hour12 ?? true
  );
}

function button(className: string, testId: string, label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.setAttribute("data-testid", testId);
  b.textContent = label;
  return b;
}

export function buildTaskDateTimeControl(initial: string): TaskDateTimeControl {
  const display = dateTimeDisplay();
  const split = splitStoredValue(initial);
  let selected: string | null = split.date;

  const storedTime =
    split.time === null ? null : /^(\d{2}):(\d{2})$/.exec(split.time);
  let hour = storedTime === null ? 9 : Number(storedTime[1]);
  let minute = storedTime === null ? 0 : Number(storedTime[2]);
  let hasTime = storedTime !== null;

  const today = todayIn(display);
  // The month on screen, the focused day, and the committed day are three
  // separate things. Browsing months with the header arrows moves the VIEW (and
  // the focus into it) but must not change the committed value: the platform
  // control did not, and a user who pans forward to look around and then saves
  // should not have a date written for them.
  let viewIso = selected ?? today;
  let cursor = selected ?? today;
  let focusDay = false;
  let focusTime = false;

  const root = document.createElement("div");
  root.className = "cm-task-field-datetime";

  // ── date ──────────────────────────────────────────────────────────────────
  const dateSection = document.createElement("div");
  dateSection.className = "cm-date-picker";

  const header = document.createElement("div");
  header.className = "cm-date-header";
  const prev = button("cm-date-nav", "editor.task-date-prev", "\u2039");
  prev.setAttribute("aria-label", i18n.t("editor.taskField.datePrev"));
  const month = document.createElement("span");
  month.className = "cm-date-month";
  month.setAttribute("data-testid", "editor.task-date-month");
  const next = button("cm-date-nav", "editor.task-date-next", "\u203a");
  next.setAttribute("aria-label", i18n.t("editor.taskField.dateNext"));
  header.append(prev, month, next);
  dateSection.appendChild(header);

  // The chosen day, printed in the user's `date_format`. The calendar grid is
  // unambiguous, but the preference is a textual format and this is where it is
  // visible (and what the chip / Tasks panel behind the popup already show).
  const valueLabel = document.createElement("div");
  valueLabel.className = "cm-date-value";
  valueLabel.setAttribute("data-testid", "editor.task-date-value");
  dateSection.appendChild(valueLabel);

  const start = firstWeekday(display.locale);

  const grid = document.createElement("div");
  grid.className = "cm-date-grid";
  grid.setAttribute("role", "grid");
  grid.setAttribute("aria-label", i18n.t("editor.taskField.dateGrid"));
  // The weekday header is a row OWNED BY the grid, not a sibling, because an
  // orphaned `role="row"` of `columnheader`s is an ARIA ownership violation axe
  // reports.
  const headerRow = document.createElement("div");
  headerRow.className = "cm-date-week cm-date-weekdays";
  headerRow.setAttribute("role", "row");
  for (const label of weekdayLabels(display.locale, start)) {
    const cell = document.createElement("span");
    cell.className = "cm-date-weekday";
    cell.setAttribute("role", "columnheader");
    cell.textContent = label;
    headerRow.appendChild(cell);
  }
  grid.appendChild(headerRow);
  dateSection.appendChild(grid);

  const clear = button(
    "cm-task-field-clear",
    "editor.task-field-clear",
    i18n.t("editor.taskField.clear"),
  );
  dateSection.appendChild(clear);
  root.appendChild(dateSection);

  // ── time ──────────────────────────────────────────────────────────────────
  const timeSection = document.createElement("div");
  timeSection.className = "cm-time-picker";
  root.appendChild(timeSection);

  function renderDate(): void {
    const d = dateOf(viewIso);
    if (d === null) return;
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    month.textContent = monthLabel(display.locale, y, m);
    valueLabel.textContent =
      selected === null ? i18n.t("editor.taskField.noDate") : formatCivilDate(selected, display);

    const firstOfMonth = new Date(Date.UTC(y, m, 1));
    const leading = (firstOfMonth.getUTCDay() - start + 7) % 7;
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const cells = Math.ceil((leading + daysInMonth) / 7) * 7;
    const firstCell = shiftDays(isoOf(firstOfMonth), -leading);

    // Keep the weekday header row; rebuild only the day rows below it.
    for (const child of [...grid.children]) if (child !== headerRow) child.remove();
    let row: HTMLElement | null = null;
    for (let i = 0; i < cells; i += 1) {
      if (i % 7 === 0) {
        row = document.createElement("div");
        row.className = "cm-date-week";
        row.setAttribute("role", "row");
        grid.appendChild(row);
      }
      const iso = shiftDays(firstCell, i);
      const cellDate = dateOf(iso);
      if (cellDate === null || cellDate.getUTCMonth() !== m) {
        const blank = document.createElement("div");
        blank.className = "cm-date-cell cm-date-day-blank";
        blank.setAttribute("role", "gridcell");
        row?.appendChild(blank);
        continue;
      }
      const isSelected = selected === iso;
      // The CELL carries the grid semantics and the button inside carries the
      // interactivity, so AT still exposes an activatable control instead of a
      // gridcell whose button role was overridden.
      const cell = document.createElement("div");
      cell.className = "cm-date-cell";
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-selected", isSelected ? "true" : "false");
      if (iso === today) cell.setAttribute("aria-current", "date");
      const dayButton = document.createElement("button");
      dayButton.type = "button";
      dayButton.className = "cm-date-day";
      dayButton.setAttribute("data-date", iso);
      dayButton.textContent = String(cellDate.getUTCDate());
      if (isSelected) dayButton.classList.add("is-selected");
      if (iso === today) dayButton.classList.add("is-today");
      dayButton.tabIndex = iso === cursor ? 0 : -1;
      // The cursor cell carries the surface's primary-control testid, so the
      // existing harness and E2E that reach for it keep working.
      dayButton.setAttribute(
        "data-testid",
        iso === cursor ? "editor.task-field-input" : "editor.task-date-day",
      );
      dayButton.addEventListener("click", () => {
        selected = iso;
        cursor = iso;
        viewIso = iso;
        renderDate();
        grid.querySelector<HTMLElement>(`[data-date="${iso}"]`)?.focus();
      });
      cell.appendChild(dayButton);
      row?.appendChild(cell);
    }

    if (focusDay) {
      focusDay = false;
      grid.querySelector<HTMLElement>('[data-testid="editor.task-field-input"]')?.focus();
    }
  }

  // The header arrows browse months. They move the view and carry the focus into
  // it, but they do NOT select a day: panning to look around and then saving must
  // not write a date the user never picked.
  prev.addEventListener("click", () => {
    viewIso = shiftMonths(viewIso, -1);
    cursor = shiftMonths(cursor, -1);
    focusDay = true;
    renderDate();
  });
  next.addEventListener("click", () => {
    viewIso = shiftMonths(viewIso, 1);
    cursor = shiftMonths(cursor, 1);
    focusDay = true;
    renderDate();
  });

  // Arrow keys DO select, so a keyboard user who arrows onto a day and presses
  // Enter commits the day they can see focused. The only state where focus and
  // selection differ is "no date", where the cursor parks on today unselected.
  grid.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    const holder = target.closest?.("[data-date]") ?? null;
    const iso = holder?.getAttribute("data-date") ?? null;
    const d = iso === null ? null : dateOf(iso);
    if (iso === null || d === null) return;
    const offset = (d.getUTCDay() - start + 7) % 7;
    let move: string | null = null;
    switch (e.key) {
      case "ArrowLeft": move = shiftDays(iso, -1); break;
      case "ArrowRight": move = shiftDays(iso, 1); break;
      case "ArrowUp": move = shiftDays(iso, -7); break;
      case "ArrowDown": move = shiftDays(iso, 7); break;
      case "PageUp": move = shiftMonths(iso, -1); break;
      case "PageDown": move = shiftMonths(iso, 1); break;
      case "Home": move = shiftDays(iso, -offset); break;
      case "End": move = shiftDays(iso, 6 - offset); break;
      default: return;
    }
    e.preventDefault();
    cursor = move;
    selected = move;
    viewIso = move;
    focusDay = true;
    renderDate();
  });

  clear.addEventListener("click", () => {
    selected = null;
    hasTime = false;
    hour = 9;
    minute = 0;
    cursor = today;
    viewIso = today;
    renderDate();
    renderTime();
  });

  function renderTime(): void {
    timeSection.textContent = "";
    if (!hasTime) {
      const add = button(
        "cm-time-add",
        "editor.task-time-add",
        i18n.t("editor.taskField.addTime"),
      );
      add.addEventListener("click", () => {
        hasTime = true;
        focusTime = true;
        renderTime();
      });
      timeSection.appendChild(add);
      return;
    }

    const h12 = usesHour12(display);
    const hourEl = document.createElement("div");
    hourEl.className = "cm-time-spin";
    hourEl.setAttribute("role", "spinbutton");
    hourEl.setAttribute("tabindex", "0");
    hourEl.setAttribute("data-testid", "editor.task-time-hour");
    hourEl.setAttribute("aria-label", i18n.t("editor.taskField.timeHour"));

    const minuteEl = document.createElement("div");
    minuteEl.className = "cm-time-spin";
    minuteEl.setAttribute("role", "spinbutton");
    minuteEl.setAttribute("tabindex", "0");
    minuteEl.setAttribute("data-testid", "editor.task-time-minute");
    minuteEl.setAttribute("aria-label", i18n.t("editor.taskField.timeMinute"));

    function sync(): void {
      const shownHour = h12 ? (hour % 12 === 0 ? 12 : hour % 12) : hour;
      hourEl.textContent = h12 ? String(shownHour) : pad2(hour);
      hourEl.setAttribute("aria-valuemin", h12 ? "1" : "0");
      hourEl.setAttribute("aria-valuemax", h12 ? "12" : "23");
      hourEl.setAttribute("aria-valuenow", String(h12 ? shownHour : hour));
      minuteEl.textContent = pad2(minute);
      minuteEl.setAttribute("aria-valuemin", "0");
      minuteEl.setAttribute("aria-valuemax", "59");
      minuteEl.setAttribute("aria-valuenow", String(minute));
      if (meridiemButton !== null) {
        meridiemButton.textContent = meridiem(display.locale, hour >= 12);
      }
    }

    let meridiemButton: HTMLButtonElement | null = null;
    if (h12) {
      meridiemButton = button(
        "cm-time-meridiem",
        "editor.task-time-meridiem",
        meridiem(display.locale, hour >= 12),
      );
      meridiemButton.setAttribute("aria-label", i18n.t("editor.taskField.timeMeridiem"));
      meridiemButton.addEventListener("click", () => {
        hour = (hour + 12) % 24;
        sync();
      });
    }

    function setHour(n: number): void {
      hour = ((n % 24) + 24) % 24;
      sync();
    }
    function setMinute(n: number): void {
      minute = ((n % 60) + 60) % 60;
      sync();
    }

    hourEl.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp") { e.preventDefault(); setHour(hour + (e.shiftKey ? 2 : 1)); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setHour(hour - (e.shiftKey ? 2 : 1)); }
      else if (e.key === "Home") { e.preventDefault(); setHour(0); }
      else if (e.key === "End") { e.preventDefault(); setHour(23); }
    });
    minuteEl.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp") { e.preventDefault(); setMinute(minute + (e.shiftKey ? 5 : 1)); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setMinute(minute - (e.shiftKey ? 5 : 1)); }
      else if (e.key === "Home") { e.preventDefault(); setMinute(0); }
      else if (e.key === "End") { e.preventDefault(); setMinute(59); }
    });

    timeSection.appendChild(hourEl);
    const colon = document.createElement("span");
    colon.className = "cm-time-colon";
    colon.setAttribute("aria-hidden", "true");
    colon.textContent = ":";
    timeSection.appendChild(colon);
    timeSection.appendChild(minuteEl);
    if (meridiemButton !== null) timeSection.appendChild(meridiemButton);

    const remove = button(
      "cm-time-remove",
      "editor.task-time-clear",
      i18n.t("editor.taskField.removeTime"),
    );
    remove.addEventListener("click", () => {
      hasTime = false;
      renderTime();
    });
    timeSection.appendChild(remove);

    sync();
    if (focusTime) {
      focusTime = false;
      hourEl.focus();
    }
  }

  renderDate();
  renderTime();

  const focusTarget =
    grid.querySelector<HTMLElement>('[data-testid="editor.task-field-input"]') ??
    dateSection;

  return {
    root,
    getValue: () =>
      selected === null ? "" : hasTime ? `${selected} ${pad2(hour)}:${pad2(minute)}` : selected,
    focusTarget,
  };
}
