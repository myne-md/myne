// The editor that opens from a task chip (MYND-614 task 6).
//
// Assembled entirely from what already exists — **zero new dependencies**, since
// a date-picker package would be a security decision needing a dependency-ledger
// row and its own decision entry:
//
//   - `openModal` (host/lib/imperative-modal) for the focus trap, Esc dismissal
//     and backdrop click;
//   - `computePosition` (positioning.ts) for the viewport clamp and above/below
//     flip, so the surface never opens off-screen;
//   - the platform `<input type="date">`, which MYND-614 task 1 measured as
//     fully supported on both reachable WebViews (macOS WKWebView and Linux
//     WebKitGTK: type retained, `showPicker()` callable, `valueAsDate`
//     round-trips, invalid values rejected). That measurement is what makes the
//     due field a thin wrapper rather than a hand-rolled calendar grid.
//   - for the repeat field, the shared recurrence model
//     (`@myne/dialect/recurrence`): the rule is **assembled from controls and
//     serialized to canonical English**, never typed. That is `markdown-dialect.md`
//     §3.8.7's normative requirement ("a rule is chosen from a control, never
//     typed"), and it is what keeps a closed vocabulary honest — the free-text box
//     this replaced could produce bytes the parser refuses.
//
// **This is the only way to edit these values in live mode.** Chips never open
// on caret entry (task 5), so it must be complete and fully keyboard-reachable
// from day one — not a follow-up. Every control here is focusable, the trap
// cycles them, Enter commits, and Escape dismisses without changing anything.
//
// The surfaces mount to `document.body`, OUTSIDE `.cm-editor`, so the CodeMirror
// `baseTheme` cannot reach them — their chrome lives in `task-surfaces.css`,
// imported here as a side effect.

import "./task-surfaces.css";
import { computePosition } from "./positioning";
import { openModal } from "./host/lib/imperative-modal";
import i18n from "@myne/editor/i18n";
import {
  formatRecurrenceSpec,
  INTERVAL_UNITS,
  ORDINALS,
  parseRecurrenceSpec,
  WEEKDAYS,
  type IntervalUnit,
  type Ordinal,
  type RecurrenceMode,
  type RecurrenceRule,
  type Weekday,
} from "@myne/dialect/recurrence";

export type TaskFieldKind = "due" | "repeat" | "priority";

export const PRIORITY_VALUES = ["highest", "high", "medium", "low", "lowest"] as const;

export type TaskFieldEditorOptions = {
  /** The chip element the editor is anchored to. */
  anchor: HTMLElement;
  kind: TaskFieldKind;
  /** Current value, as written in the source. */
  value: string;
  /** Called with the new value when the user commits. Never called on dismiss. */
  onCommit: (next: string) => void;
  /** Called when dismissed without committing. */
  onCancel?: () => void;
  /**
   * Optional label overrides. Left in for callers that want them, but the
   * defaults now come from the shared catalogue rather than hard-coded English —
   * the desktop caller passes none, so without this the Save/Cancel buttons
   * shipped untranslated.
   */
  labels?: { commit?: string; cancel?: string; field?: string };
};

export type TaskFieldEditorHandle = { close: () => void };

/** The body of the surface: its root element, the value it currently holds, and
 *  the control that should take initial focus. */
type FieldBody = {
  readonly root: HTMLElement;
  readonly getValue: () => string;
  readonly focusTarget: HTMLElement;
};

/** The four recurrence families the control offers, one per rule kind. */
type RecurrenceFamily = "interval" | "weekdays" | "dayOfMonth" | "ordinal";

/**
 * Build the repeat field's control.
 *
 * Every rule is **assembled and serialized**, never typed: the family selector
 * chooses a shape, the sub-controls fill it in, and `formatRecurrenceSpec`
 * renders canonical English. An existing value is read back through
 * `parseRecurrenceSpec`; an unrecognized one seeds a sensible default (the user
 * opened the editor to change it, and cancelling leaves the original bytes
 * untouched).
 */
function buildRecurrenceControl(value: string): FieldBody {
  const parsed = parseRecurrenceSpec(value);
  const seed = parsed.ok ? parsed.spec : null;

  const root = document.createElement("div");
  root.className = "cm-recurrence";

  // Family selector — the surface's primary input, so it carries the shared
  // testid the harness and the unit suite look for.
  const family = document.createElement("select");
  family.className = "cm-recurrence-family";
  family.setAttribute("data-testid", "editor.task-field-input");
  family.setAttribute("aria-label", i18n.t("recurrence.builder.family"));
  const familyOptions: ReadonlyArray<{ value: RecurrenceFamily; label: string }> = [
    { value: "interval", label: i18n.t("recurrence.builder.familyInterval") },
    { value: "weekdays", label: i18n.t("recurrence.builder.familyWeekdays") },
    { value: "dayOfMonth", label: i18n.t("recurrence.builder.familyDayOfMonth") },
    { value: "ordinal", label: i18n.t("recurrence.builder.familyOrdinal") },
  ];
  for (const option of familyOptions) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    family.appendChild(node);
  }
  root.appendChild(family);

  // interval: `every N unit`
  const intervalRow = document.createElement("div");
  intervalRow.className = "cm-recurrence-row";
  const count = document.createElement("input");
  count.type = "number";
  count.min = "1";
  count.max = "999";
  count.value = "1";
  count.className = "cm-recurrence-count";
  count.setAttribute("data-testid", "editor.recurrence-count");
  count.setAttribute("aria-label", i18n.t("recurrence.builder.count"));
  const unit = document.createElement("select");
  unit.setAttribute("data-testid", "editor.recurrence-unit");
  unit.setAttribute("aria-label", i18n.t("recurrence.builder.unitLabel"));
  for (const intervalUnit of INTERVAL_UNITS) {
    const node = document.createElement("option");
    node.value = intervalUnit;
    node.textContent = i18n.t(`recurrence.builder.units.${intervalUnit}`);
    unit.appendChild(node);
  }
  intervalRow.appendChild(count);
  intervalRow.appendChild(unit);
  root.appendChild(intervalRow);

  // weekdays: a wrapping row of pressable pills, at least one always selected
  const weekdayRow = document.createElement("div");
  weekdayRow.className = "cm-recurrence-row cm-recurrence-weekdays";
  weekdayRow.setAttribute("data-testid", "editor.recurrence-weekdays");
  const dayButtons = new Map<Weekday, HTMLButtonElement>();
  function selectedDays(): Weekday[] {
    return WEEKDAYS.filter((day) => dayButtons.get(day)?.getAttribute("aria-pressed") === "true");
  }
  for (const day of WEEKDAYS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-recurrence-day";
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", i18n.t(`recurrence.weekday.${day}`));
    button.setAttribute("data-testid", `editor.recurrence-day-${day}`);
    button.title = i18n.t(`recurrence.weekday.${day}`);
    button.textContent = i18n.t(`recurrence.builder.weekdayShort.${day}`);
    button.addEventListener("click", () => {
      const pressed = button.getAttribute("aria-pressed") === "true";
      // Refuse to clear the last remaining day: a weekday rule with no days is
      // not a rule.
      if (pressed && selectedDays().length === 1) return;
      button.setAttribute("aria-pressed", pressed ? "false" : "true");
    });
    dayButtons.set(day, button);
    weekdayRow.appendChild(button);
  }
  root.appendChild(weekdayRow);

  // dayOfMonth: 1..31 plus "last day"
  const domRow = document.createElement("div");
  domRow.className = "cm-recurrence-row";
  const dayOfMonth = document.createElement("select");
  dayOfMonth.setAttribute("data-testid", "editor.recurrence-dayofmonth");
  dayOfMonth.setAttribute("aria-label", i18n.t("recurrence.builder.familyDayOfMonth"));
  for (let day = 1; day <= 31; day += 1) {
    const node = document.createElement("option");
    node.value = String(day);
    node.textContent = String(day);
    dayOfMonth.appendChild(node);
  }
  const lastDayOption = document.createElement("option");
  lastDayOption.value = "last";
  lastDayOption.textContent = i18n.t("recurrence.builder.lastDay");
  dayOfMonth.appendChild(lastDayOption);
  domRow.appendChild(dayOfMonth);
  root.appendChild(domRow);

  // ordinal: `<ordinal> <weekday> of every month`
  const ordinalRow = document.createElement("div");
  ordinalRow.className = "cm-recurrence-row";
  const ordinal = document.createElement("select");
  ordinal.setAttribute("data-testid", "editor.recurrence-ordinal");
  ordinal.setAttribute("aria-label", i18n.t("recurrence.builder.ordinal"));
  for (const ordinalValue of ORDINALS) {
    const node = document.createElement("option");
    node.value = ordinalValue;
    node.textContent = i18n.t(`recurrence.ordinal.${ordinalValue}`);
    ordinal.appendChild(node);
  }
  const ordinalWeekday = document.createElement("select");
  ordinalWeekday.setAttribute("data-testid", "editor.recurrence-ordinal-weekday");
  ordinalWeekday.setAttribute("aria-label", i18n.t("recurrence.builder.weekday"));
  for (const day of WEEKDAYS) {
    const node = document.createElement("option");
    node.value = day;
    node.textContent = i18n.t(`recurrence.weekday.${day}`);
    ordinalWeekday.appendChild(node);
  }
  ordinalRow.appendChild(ordinal);
  ordinalRow.appendChild(ordinalWeekday);
  root.appendChild(ordinalRow);

  // Completion-anchoring: the ` when done` opt-in, carried in the rule itself.
  const modeLabel = document.createElement("label");
  modeLabel.className = "cm-recurrence-mode";
  const mode = document.createElement("input");
  mode.type = "checkbox";
  mode.setAttribute("data-testid", "editor.recurrence-when-done");
  const modeText = document.createElement("span");
  modeText.textContent = i18n.t("recurrence.builder.whenDone");
  modeLabel.appendChild(mode);
  modeLabel.appendChild(modeText);
  root.appendChild(modeLabel);

  const rows: Record<RecurrenceFamily, HTMLElement> = {
    interval: intervalRow,
    weekdays: weekdayRow,
    dayOfMonth: domRow,
    ordinal: ordinalRow,
  };
  function syncRows(): void {
    for (const key of Object.keys(rows) as RecurrenceFamily[]) {
      rows[key].hidden = key !== (family.value as RecurrenceFamily);
    }
  }
  family.addEventListener("change", syncRows);

  // Seed from the existing value, or a plain weekly default.
  if (seed !== null) {
    const rule = seed.rule;
    switch (rule.kind) {
      case "interval":
        family.value = "interval";
        count.value = String(rule.count);
        unit.value = rule.unit;
        break;
      case "weekdays":
        family.value = "weekdays";
        for (const day of rule.days) dayButtons.get(day)?.setAttribute("aria-pressed", "true");
        break;
      case "dayOfMonth":
        family.value = "dayOfMonth";
        dayOfMonth.value = rule.day === "last" ? "last" : String(rule.day);
        break;
      case "ordinal":
        family.value = "ordinal";
        ordinal.value = rule.ordinal;
        ordinalWeekday.value = rule.weekday;
        break;
    }
    if (seed.mode === "completion") mode.checked = true;
  } else {
    family.value = "interval";
    unit.value = "week";
  }
  // Guarantee the weekday family is never empty, even when seeded elsewhere.
  if (selectedDays().length === 0) {
    dayButtons.get("monday")?.setAttribute("aria-pressed", "true");
  }
  syncRows();

  const getValue = (): string => {
    const active = family.value as RecurrenceFamily;
    let rule: RecurrenceRule;
    switch (active) {
      case "interval": {
        const n = Math.min(999, Math.max(1, Math.floor(Number(count.value) || 1)));
        rule = { kind: "interval", unit: unit.value as IntervalUnit, count: n };
        break;
      }
      case "weekdays": {
        const days = selectedDays();
        rule = { kind: "weekdays", days: days.length > 0 ? days : ["monday"] };
        break;
      }
      case "dayOfMonth":
        rule = { kind: "dayOfMonth", day: dayOfMonth.value === "last" ? "last" : Number(dayOfMonth.value) };
        break;
      case "ordinal":
        rule = {
          kind: "ordinal",
          ordinal: ordinal.value as Ordinal,
          weekday: ordinalWeekday.value as Weekday,
        };
        break;
      default: {
        // Exhaustiveness guard: an unhandled family is a compile error.
        const exhaustive: never = active;
        return exhaustive;
      }
    }
    const anchoring: RecurrenceMode = mode.checked ? "completion" : "due";
    return formatRecurrenceSpec({ rule, mode: anchoring });
  };

  return { root, getValue, focusTarget: family };
}

/** The body the surface edits, built per field kind. */
function buildBody(kind: TaskFieldKind, value: string): FieldBody {
  if (kind === "repeat") return buildRecurrenceControl(value);

  if (kind === "priority") {
    const select = document.createElement("select");
    for (const level of PRIORITY_VALUES) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      select.appendChild(option);
    }
    select.value = PRIORITY_VALUES.includes(value as never) ? value : "medium";
    select.setAttribute("data-testid", "editor.task-field-input");
    return { root: select, getValue: () => select.value, focusTarget: select };
  }

  // `due` — the native date control (task 1's measurement). A date-only value
  // goes straight in; a value carrying a time keeps its date part (the time
  // editor is a later slice, and dropping it silently would be worse than
  // ignoring it here).
  const input = document.createElement("input");
  input.type = "date";
  input.value = value.slice(0, 10);
  input.setAttribute("data-testid", "editor.task-field-input");
  return { root: input, getValue: () => input.value, focusTarget: input };
}

/**
 * Open the editor for one task field, anchored to its chip.
 *
 * Returns a handle whose `close` is idempotent. Escape and a backdrop click
 * dismiss **without** committing; Enter and the commit button commit.
 */
export function openTaskFieldEditor(
  options: TaskFieldEditorOptions,
): TaskFieldEditorHandle {
  const { anchor, kind, value, onCommit, onCancel, labels } = options;

  let committed = false;

  const modal = openModal({
    backdropStyle: {
      // A full-screen but transparent backdrop: this is an anchored popover, not
      // a blocking dialog, so it must not dim — but it does need to span the
      // viewport so a click anywhere outside the surface dismisses it (the
      // backdrop-click path in openModal fires only for clicks ON the backdrop).
      position: "fixed",
      inset: "0",
      background: "transparent",
      zIndex: "2147483000",
    },
    onDismiss: () => {
      modal.close();
      if (!committed) onCancel?.();
    },
    onEnter: (e) => {
      e.preventDefault();
      commit();
    },
  });

  const surface = document.createElement("div");
  surface.className = "cm-task-field-editor";
  surface.setAttribute("role", "dialog");
  surface.setAttribute("aria-label", labels?.field ?? i18n.t(`editor.taskField.title.${kind}`));
  surface.setAttribute("data-testid", "editor.task-field-editor");
  // Set inline too, not only in the stylesheet: `computePosition`'s left/top are
  // inline and only take effect once the surface is out of normal flow, and a
  // bare test DOM never applies the imported CSS.
  surface.style.position = "fixed";

  const body = buildBody(kind, value);
  surface.appendChild(body.root);

  const actions = document.createElement("div");
  actions.className = "cm-task-field-actions";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = labels?.cancel ?? i18n.t("common.cancel");
  cancelButton.setAttribute("data-testid", "editor.task-field-cancel");
  actions.appendChild(cancelButton);

  const commitButton = document.createElement("button");
  commitButton.type = "button";
  commitButton.textContent = labels?.commit ?? i18n.t("editor.taskField.save");
  commitButton.setAttribute("data-testid", "editor.task-field-commit");
  actions.appendChild(commitButton);

  surface.appendChild(actions);

  function commit(): void {
    committed = true;
    const next = body.getValue();
    modal.close();
    onCommit(next);
  }

  commitButton.addEventListener("click", commit);
  cancelButton.addEventListener("click", () => {
    modal.close();
    onCancel?.();
  });

  modal.backdrop.appendChild(surface);

  // Position after mounting so the surface has measurable dimensions. The
  // positioner owns the viewport clamp and the above/below flip.
  const rect = anchor.getBoundingClientRect();
  const placed = computePosition({
    anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    surfaceWidth: surface.offsetWidth || 240,
    surfaceHeight: surface.offsetHeight || 96,
    preferredPlacement: "below",
  });
  surface.style.left = `${placed.left}px`;
  surface.style.top = `${placed.top}px`;

  // Trap on the surface, not the backdrop, so a backdrop click still dismisses.
  // Initial focus is the body's primary control: the whole surface is reachable
  // by keyboard alone from here — Tab cycles the controls and wraps.
  modal.installTrap(surface, body.focusTarget);

  return {
    close: () => {
      modal.close();
    },
  };
}
