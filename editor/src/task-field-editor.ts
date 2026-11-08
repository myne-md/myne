// The editor that opens from a task chip (MYND-614 task 6).
//
// Assembled entirely from what already exists - **zero new dependencies**, since
// a date-picker package would be a security decision needing a dependency-ledger
// row and its own decision entry:
//
//   - `openModal` (host/lib/imperative-modal) for the focus trap, Esc dismissal
//     and backdrop click;
//   - `computePosition` (positioning.ts) for the viewport clamp and above/below
//     flip, so the surface never opens off-screen;
//   - `buildTaskDateTimeControl` (task-date-time-picker.ts), the Myne-owned date
//     + time picker for the due / remind fields. It replaced the platform
//     `<input type="date">` / `<input type="time">`, whose visible format is the
//     WebView's region setting and ignored the `date_format` / `time_format`
//     prefs (myne-md/myne#614; the reversal and what changed since the earlier
//     measurement are recorded in `myne-agents/docs/decisions/editor/0586-*`);
//   - for the repeat field, the shared recurrence model
//     (`@myne/dialect/recurrence`): the rule is **assembled from controls and
//     serialized to canonical English**, never typed. That is `markdown-dialect.md`
//     §3.8.7's normative requirement ("a rule is chosen from a control, never
//     typed"), and it is what keeps a closed vocabulary honest - the free-text box
//     this replaced could produce bytes the parser refuses.
//
// **This is the only way to edit these values in live mode.** Chips never open
// on caret entry (task 5), so it must be complete and fully keyboard-reachable
// from day one - not a follow-up. Every control here is focusable, the trap
// cycles them, Enter commits, and Escape dismisses without changing anything.
//
// The surfaces mount to `document.body`, OUTSIDE `.cm-editor`, so the CodeMirror
// `baseTheme` cannot reach them - their chrome lives in `task-surfaces.css`,
// imported here as a side effect.

import "./task-surfaces.css";
import { computePosition, type Rect } from "./positioning";
import { openModal } from "./host/lib/imperative-modal";
import { buildTaskDateTimeControl } from "./task-date-time-picker";
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

export type TaskFieldKind = "due" | "remind" | "repeat" | "priority";

export const PRIORITY_VALUES = ["highest", "high", "medium", "low", "lowest"] as const;

export type TaskFieldEditorOptions = {
  /**
   * What the editor is anchored to. A chip / `+` button (an element) or a bare
   * viewport rectangle - the slash commands have no element to point at, only a
   * caret coordinate from `view.coordsAtPos`. Positioning reads only the rect,
   * so both are equivalent here.
   */
  anchor: HTMLElement | Rect;
  kind: TaskFieldKind;
  /** Current value, as written in the source. */
  value: string;
  /** Called with the new value when the user commits. Never called on dismiss. */
  onCommit: (next: string) => void;
  /** Called when dismissed without committing. */
  onCancel?: () => void;
  /**
   * Optional label overrides. Left in for callers that want them, but the
   * defaults now come from the shared catalogue rather than hard-coded English -
   * the desktop caller passes none, so without this the Save/Cancel buttons
   * shipped untranslated.
   */
  labels?: { commit?: string; cancel?: string; field?: string };
  /**
   * Mount into caller-owned chrome instead of creating a modal. The CALLER owns
   * the backdrop, the focus trap and the Escape/Enter routing.
   *
   * TWO shapes, and the difference is whether the actions row stays with the body:
   *
   *   - `{ body }` alone: the surface is a card inside BODY, its Cancel/Save row
   *     included. That is the anchored two-pane menu's right pane.
   *   - `{ body, actions }`: the controls go into BODY and the Cancel/Save row into
   *     ACTIONS, with no card around either. That is the docked sheet, whose
   *     actions row is a SIBLING of its scrolling region so the two cannot scroll
   *     apart (myne-md/myne#884).
   */
  host?: { body: HTMLElement; actions?: HTMLElement };
};

export type TaskFieldEditorHandle = {
  close: () => void;
  /**
   * When hosted: consume an Escape. Returns `true` if a select listbox was open
   * and has been closed (so the host should NOT also close the pane). Absent on
   * the modal path, where `openModal` already routes Escape.
   */
  escape?: () => boolean;
};

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
 * The hand-rolled controls (myne-md/myne#656).
 *
 * A native `<select>` and `<input type="number">` render the platform's own
 * chrome, which no custom theme can repaint - the same failure
 * `src/components/primitives/Select.tsx` closed everywhere else. These are the
 * vanilla equivalents: a combobox trigger with a listbox popup, a spinbutton and
 * a switch, built from buttons / inputs so the token layer reaches them and every
 * state is keyboard-operable. Zero new dependency (`computePosition` is already
 * here).
 */

/** One choice in a hand-rolled listbox. */
type SelectOption = { readonly value: string; readonly label: string };

/**
 * How a select tells the editor that a popup opened or closed.
 *
 * Escape and Enter are captured at the document by `openModal`, BEFORE anything
 * inside the surface sees them, so the editor has to route both to an open popup
 * itself: Escape closes the listbox, Enter lets the focused option choose instead
 * of committing the whole field. `id` is the control's identity, so an
 * overlapping popup cannot unregister the wrong one.
 */
type FieldPopupHost = {
  readonly opened: (id: object, close: () => void) => void;
  readonly closed: (id: object) => void;
};

/** A hand-rolled select: its wrapper, its trigger button and its value. */
type SelectControl = {
  readonly root: HTMLElement;
  readonly el: HTMLButtonElement;
  readonly getValue: () => string;
  readonly setValue: (value: string) => void;
};

/**
 * Build a listbox-backed combobox, mirroring `Select.tsx`'s ARIA and keys.
 *
 * The listbox is mounted INSIDE the surface (not a body portal) so the field
 * editor's focus trap owns it. Options carry `tabindex="-1"` so they never join
 * the trap's Tab ring; they take programmatic focus, which is how the arrow keys
 * move.
 */
function buildSelectControl(config: {
  testId: string;
  ariaLabel: string;
  className?: string;
  options: ReadonlyArray<SelectOption>;
  value: string;
  onChange?: (value: string) => void;
  popup?: FieldPopupHost;
}): SelectControl {
  const resolved = config.options.some((o) => o.value === config.value)
    ? config.value
    : (config.options[0]?.value ?? "");
  let current = resolved;
  let open = false;
  let listbox: HTMLElement | null = null;
  let activeIndex = Math.max(0, config.options.findIndex((o) => o.value === current));
  const self = {};

  const wrapper = document.createElement("span");
  wrapper.className = "cm-select";
  if (config.className !== undefined) wrapper.classList.add(config.className);

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cm-select-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", config.ariaLabel);
  trigger.setAttribute("data-testid", config.testId);
  trigger.setAttribute("data-value", current);

  const valueLabel = document.createElement("span");
  valueLabel.className = "cm-select-value";
  const chevron = document.createElement("span");
  chevron.className = "cm-select-chevron";
  chevron.setAttribute("aria-hidden", "true");
  trigger.appendChild(valueLabel);
  trigger.appendChild(chevron);
  wrapper.appendChild(trigger);

  const labelFor = (value: string): string =>
    config.options.find((o) => o.value === value)?.label ?? value;
  const syncTrigger = (): void => {
    valueLabel.textContent = labelFor(current);
    trigger.setAttribute("data-value", current);
  };

  const optionNodes = (): HTMLElement[] =>
    listbox === null ? [] : Array.from(listbox.querySelectorAll<HTMLElement>(".cm-select-option"));

  const setActive = (index: number): void => {
    const nodes = optionNodes();
    if (nodes.length === 0) return;
    activeIndex = Math.max(0, Math.min(nodes.length - 1, index));
    nodes.forEach((node, i) =>
      node.setAttribute("data-active", i === activeIndex ? "true" : "false"),
    );
    nodes[activeIndex]?.focus();
  };

  const closePopup = (refocus: boolean): void => {
    if (!open) return;
    open = false;
    trigger.setAttribute("aria-expanded", "false");
    listbox?.remove();
    listbox = null;
    config.popup?.closed(self);
    if (refocus) trigger.focus();
  };

  const choose = (index: number): void => {
    const option = config.options[index];
    if (option !== undefined && option.value !== current) {
      current = option.value;
      syncTrigger();
      config.onChange?.(current);
    }
    closePopup(true);
  };

  const openPopup = (): void => {
    if (open) return;
    open = true;
    trigger.setAttribute("aria-expanded", "true");
    activeIndex = Math.max(0, config.options.findIndex((o) => o.value === current));
    const menu = document.createElement("div");
    menu.className = "cm-select-listbox";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", config.ariaLabel);
    menu.style.position = "fixed";
    menu.style.visibility = "hidden";
    config.options.forEach((option, index) => {
      const node = document.createElement("div");
      node.className = "cm-select-option";
      node.setAttribute("role", "option");
      node.setAttribute("aria-selected", option.value === current ? "true" : "false");
      node.setAttribute("data-testid", `${config.testId}-option`);
      node.setAttribute("data-value", option.value);
      node.setAttribute("data-active", index === activeIndex ? "true" : "false");
      node.tabIndex = -1;
      node.textContent = option.label;
      // Keep focus on the option through the press without starting a text
      // selection; the click handler still selects.
      node.addEventListener("mousedown", (e) => e.preventDefault());
      node.addEventListener("click", () => choose(index));
      node.addEventListener("mouseenter", () => setActive(index));
      menu.appendChild(node);
    });
    wrapper.appendChild(menu);
    listbox = menu;
    config.popup?.opened(self, () => closePopup(true));
    // Mount first so the popup has measurable dimensions, then let the shared
    // positioner clamp it and flip it above when there is no room below.
    const rect = trigger.getBoundingClientRect();
    const placed = computePosition({
      anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      surfaceWidth: menu.offsetWidth || 160,
      surfaceHeight: menu.offsetHeight || 160,
      preferredPlacement: "below",
    });
    menu.style.left = `${placed.left}px`;
    menu.style.top = `${placed.top}px`;
    menu.style.visibility = "";
    setActive(activeIndex);
  };

  trigger.addEventListener("keydown", (e) => {
    if (open) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openPopup();
    }
  });

  // One delegated listener on the wrapper: the focused option is the event
  // target, so the container catches every key without per-option wiring. The
  // `contains` guard keeps the trigger's own keys from double-stepping.
  wrapper.addEventListener("keydown", (e) => {
    if (!open || listbox === null || !listbox.contains(e.target as Node)) return;
    const nodes = optionNodes();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive(activeIndex + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive(activeIndex - 1);
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(nodes.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(activeIndex);
        break;
      case "Escape":
        e.preventDefault();
        closePopup(true);
        break;
      case "Tab":
        // Let focus move on; the popup closes with the selection unchanged.
        closePopup(false);
        break;
    }
  });

  trigger.addEventListener("click", () => {
    if (open) closePopup(true);
    else openPopup();
  });

  syncTrigger();
  return {
    root: wrapper,
    el: trigger,
    getValue: () => current,
    setValue: (value: string) => {
      if (!config.options.some((o) => o.value === value)) return;
      current = value;
      syncTrigger();
    },
  };
}

/** A hand-rolled numeric spinbutton: a text input that accepts digits only. */
type NumberControl = {
  readonly el: HTMLInputElement;
  readonly getValue: () => number;
  readonly setValue: (value: number) => void;
};

function buildNumberControl(config: {
  testId: string;
  ariaLabel: string;
  className?: string;
  value: number;
  min: number;
  max: number;
}): NumberControl {
  const el = document.createElement("input");
  el.type = "text";
  el.inputMode = "numeric";
  el.autocomplete = "off";
  el.className =
    config.className === undefined ? "cm-stepper" : `cm-stepper ${config.className}`;
  el.setAttribute("role", "spinbutton");
  el.setAttribute("aria-valuemin", String(config.min));
  el.setAttribute("aria-valuemax", String(config.max));
  el.setAttribute("aria-label", config.ariaLabel);
  el.setAttribute("data-testid", config.testId);

  const clamp = (value: number): number => {
    const whole = Number.isFinite(value) ? Math.floor(value) : config.min;
    return Math.min(config.max, Math.max(config.min, whole));
  };
  const syncValueNow = (): void => {
    el.setAttribute("aria-valuenow", String(clamp(Number(el.value))));
  };
  el.value = String(clamp(config.value));
  syncValueNow();

  el.addEventListener("input", () => {
    const digits = el.value.replace(/[^\d]/g, "");
    if (digits !== el.value) el.value = digits;
    syncValueNow();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const step = e.key === "ArrowUp" ? 1 : -1;
      el.value = String(clamp((Number(el.value) || config.min) + step));
      syncValueNow();
    } else if (e.key === "Home") {
      e.preventDefault();
      el.value = String(config.min);
      syncValueNow();
    } else if (e.key === "End") {
      e.preventDefault();
      el.value = String(config.max);
      syncValueNow();
    }
  });
  // Clamp on the way out: a typed `0` or `1000` commits as a real bound rather
  // than the number the user happened to leave in the box.
  el.addEventListener("blur", () => {
    el.value = String(clamp(Number(el.value)));
    syncValueNow();
  });

  return {
    el,
    getValue: () => clamp(Number(el.value)),
    setValue: (value: number) => {
      el.value = String(clamp(value));
      syncValueNow();
    },
  };
}

/** A hand-rolled completion switch (`role="switch"`), replacing the checkbox. */
type ToggleControl = {
  readonly root: HTMLElement;
  readonly isChecked: () => boolean;
  readonly setChecked: (checked: boolean) => void;
};

function buildToggleControl(config: {
  testId: string;
  label: string;
  checked: boolean;
}): ToggleControl {
  let checked = config.checked;
  const root = document.createElement("div");
  root.className = "cm-recurrence-mode";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-switch";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-label", config.label);
  button.setAttribute("data-testid", config.testId);
  const track = document.createElement("span");
  track.className = "cm-switch-track";
  track.setAttribute("aria-hidden", "true");
  const knob = document.createElement("span");
  knob.className = "cm-switch-knob";
  track.appendChild(knob);
  button.appendChild(track);
  const label = document.createElement("span");
  label.className = "cm-switch-label";
  label.textContent = config.label;
  root.appendChild(button);
  root.appendChild(label);

  const sync = (): void => button.setAttribute("aria-checked", checked ? "true" : "false");
  const toggle = (): void => {
    checked = !checked;
    sync();
  };
  button.addEventListener("click", toggle);
  // The visible label is part of the hit target, the way a native <label> is.
  label.addEventListener("click", toggle);
  sync();
  return {
    root,
    isChecked: () => checked,
    setChecked: (value: boolean) => {
      checked = value;
      sync();
    },
  };
}

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
function buildRecurrenceControl(value: string, popup: FieldPopupHost): FieldBody {
  const parsed = parseRecurrenceSpec(value);
  const seed = parsed.ok ? parsed.spec : null;

  const root = document.createElement("div");
  root.className = "cm-recurrence";

  // Family selector - the surface's primary input, so it carries the shared
  // testid the harness and the unit suite look for.
  const familyOptions: ReadonlyArray<{ value: RecurrenceFamily; label: string }> = [
    { value: "interval", label: i18n.t("recurrence.builder.familyInterval") },
    { value: "weekdays", label: i18n.t("recurrence.builder.familyWeekdays") },
    { value: "dayOfMonth", label: i18n.t("recurrence.builder.familyDayOfMonth") },
    { value: "ordinal", label: i18n.t("recurrence.builder.familyOrdinal") },
  ];
  const family = buildSelectControl({
    testId: "editor.task-field-input",
    ariaLabel: i18n.t("recurrence.builder.family"),
    className: "cm-recurrence-family",
    options: familyOptions,
    value: "interval",
    onChange: () => syncRows(),
    popup,
  });
  root.appendChild(family.root);

  // interval: `every N unit`
  const intervalRow = document.createElement("div");
  intervalRow.className = "cm-recurrence-row";
  const count = buildNumberControl({
    testId: "editor.recurrence-count",
    ariaLabel: i18n.t("recurrence.builder.count"),
    className: "cm-recurrence-count",
    value: 1,
    min: 1,
    max: 999,
  });
  const unit = buildSelectControl({
    testId: "editor.recurrence-unit",
    ariaLabel: i18n.t("recurrence.builder.unitLabel"),
    options: INTERVAL_UNITS.map((intervalUnit) => ({
      value: intervalUnit,
      label: i18n.t(`recurrence.builder.units.${intervalUnit}`),
    })),
    value: "week",
    popup,
  });
  intervalRow.appendChild(count.el);
  intervalRow.appendChild(unit.root);
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
  const dayOfMonth = buildSelectControl({
    testId: "editor.recurrence-dayofmonth",
    ariaLabel: i18n.t("recurrence.builder.familyDayOfMonth"),
    options: [
      ...Array.from({ length: 31 }, (_, index) => ({
        value: String(index + 1),
        label: String(index + 1),
      })),
      { value: "last", label: i18n.t("recurrence.builder.lastDay") },
    ],
    value: "1",
    popup,
  });
  domRow.appendChild(dayOfMonth.root);
  root.appendChild(domRow);

  // ordinal: `<ordinal> <weekday> of every month`
  const ordinalRow = document.createElement("div");
  ordinalRow.className = "cm-recurrence-row";
  const ordinal = buildSelectControl({
    testId: "editor.recurrence-ordinal",
    ariaLabel: i18n.t("recurrence.builder.ordinal"),
    options: ORDINALS.map((ordinalValue) => ({
      value: ordinalValue,
      label: i18n.t(`recurrence.ordinal.${ordinalValue}`),
    })),
    value: "first",
    popup,
  });
  const ordinalWeekday = buildSelectControl({
    testId: "editor.recurrence-ordinal-weekday",
    ariaLabel: i18n.t("recurrence.builder.weekday"),
    options: WEEKDAYS.map((day) => ({
      value: day,
      label: i18n.t(`recurrence.weekday.${day}`),
    })),
    value: "monday",
    popup,
  });
  ordinalRow.appendChild(ordinal.root);
  ordinalRow.appendChild(ordinalWeekday.root);
  root.appendChild(ordinalRow);

  // Completion-anchoring: the ` when done` opt-in, carried in the rule itself.
  const mode = buildToggleControl({
    testId: "editor.recurrence-when-done",
    label: i18n.t("recurrence.builder.whenDone"),
    checked: false,
  });
  root.appendChild(mode.root);

  const rows: Record<RecurrenceFamily, HTMLElement> = {
    interval: intervalRow,
    weekdays: weekdayRow,
    dayOfMonth: domRow,
    ordinal: ordinalRow,
  };
  // `hidden` AND an inline `display`, which is belt-and-braces on purpose.
  // `base.css`'s `[hidden]` reset is what makes the attribute bind, but these
  // rows are the surface that proved the attribute alone is not enough: an
  // inline declaration cannot be outvoted by any stylesheet, so the control
  // stays correct even in a host that never loads the reset. It is also the only
  // form the fast test lane can see - jsdom applies no CSS, so an assertion on
  // `hidden` passes whether or not the row is actually visible.
  //
  // The visible state clears the inline value rather than restating `flex`, so
  // the stylesheet keeps owning what "shown" looks like.
  function syncRows(): void {
    for (const key of Object.keys(rows) as RecurrenceFamily[]) {
      const hide = key !== (family.getValue() as RecurrenceFamily);
      rows[key].hidden = hide;
      rows[key].style.display = hide ? "none" : "";
    }
  }

  // Seed from the existing value, or a plain weekly default.
  if (seed !== null) {
    const rule = seed.rule;
    switch (rule.kind) {
      case "interval":
        family.setValue("interval");
        count.setValue(rule.count);
        unit.setValue(rule.unit);
        break;
      case "weekdays":
        family.setValue("weekdays");
        for (const day of rule.days) dayButtons.get(day)?.setAttribute("aria-pressed", "true");
        break;
      case "dayOfMonth":
        family.setValue("dayOfMonth");
        dayOfMonth.setValue(rule.day === "last" ? "last" : String(rule.day));
        break;
      case "ordinal":
        family.setValue("ordinal");
        ordinal.setValue(rule.ordinal);
        ordinalWeekday.setValue(rule.weekday);
        break;
    }
    if (seed.mode === "completion") mode.setChecked(true);
  } else {
    family.setValue("interval");
    unit.setValue("week");
  }
  // Guarantee the weekday family is never empty, even when seeded elsewhere.
  if (selectedDays().length === 0) {
    dayButtons.get("monday")?.setAttribute("aria-pressed", "true");
  }
  syncRows();

  const getValue = (): string => {
    const active = family.getValue() as RecurrenceFamily;
    let rule: RecurrenceRule;
    switch (active) {
      case "interval": {
        const n = count.getValue();
        rule = { kind: "interval", unit: unit.getValue() as IntervalUnit, count: n };
        break;
      }
      case "weekdays": {
        const days = selectedDays();
        rule = { kind: "weekdays", days: days.length > 0 ? days : ["monday"] };
        break;
      }
      case "dayOfMonth":
        rule = {
          kind: "dayOfMonth",
          day: dayOfMonth.getValue() === "last" ? "last" : Number(dayOfMonth.getValue()),
        };
        break;
      case "ordinal":
        rule = {
          kind: "ordinal",
          ordinal: ordinal.getValue() as Ordinal,
          weekday: ordinalWeekday.getValue() as Weekday,
        };
        break;
      default: {
        // Exhaustiveness guard: an unhandled family is a compile error.
        const exhaustive: never = active;
        return exhaustive;
      }
    }
    const anchoring: RecurrenceMode = mode.isChecked() ? "completion" : "due";
    return formatRecurrenceSpec({ rule, mode: anchoring });
  };

  return { root, getValue, focusTarget: family.el };
}

/** The body the surface edits, built per field kind. */
function buildBody(kind: TaskFieldKind, value: string, popup: FieldPopupHost): FieldBody {
  if (kind === "repeat") return buildRecurrenceControl(value, popup);

  if (kind === "priority") {
    const select = buildSelectControl({
      testId: "editor.task-field-input",
      ariaLabel: i18n.t("editor.taskField.title.priority"),
      options: PRIORITY_VALUES.map((level) => ({ value: level, label: level })),
      value: PRIORITY_VALUES.includes(value as never) ? value : "medium",
      popup,
    });
    return { root: select.root, getValue: () => select.getValue(), focusTarget: select.el };
  }

  // `due` and `remind`: the Myne-owned date + optional time picker
  // (myne-md/myne#614). Replaces the platform `<input type="date">` /
  // `<input type="time">` whose visible format was the WebView's region setting
  // and could not be styled or localized by the page. The stored bytes are
  // unchanged (`YYYY-MM-DD`, optionally ` HH:mm`, wall clock, no zone); see the
  // picker module header for the full contract.
  return buildTaskDateTimeControl(value);
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
  const { anchor, kind, value, onCommit, onCancel, labels, host } = options;

  let committed = false;

  // An open select popup sits on top of the surface, and `openModal` captures
  // Escape and Enter at the document before the popup can see either. Route
  // both through here: Escape closes the listbox (not the whole editor), and
  // Enter is left to the focused option rather than committing the field.
  let activePopup: { id: object; close: () => void } | null = null;
  const popupHost: FieldPopupHost = {
    opened: (id, close) => {
      const previous = activePopup;
      activePopup = { id, close };
      if (previous !== null && previous.id !== id) previous.close();
    },
    closed: (id) => {
      if (activePopup !== null && activePopup.id === id) activePopup = null;
    },
  };
  const closeActivePopup = (): boolean => {
    const current = activePopup;
    if (current === null) return false;
    current.close();
    return true;
  };

  // The modal path (a chip click or a slash command). The HOSTED path mounts
  // into the two-pane menu's right pane and leaves backdrop, trap and
  // Escape/Enter routing to the menu (myne-md/myne#656 review).
  const modal = host === undefined ? openModal({
    backdropStyle: {
      // A full-screen but transparent backdrop: this is an anchored popover, not
      // a blocking dialog, so it must not dim - but it does need to span the
      // viewport so a click anywhere outside the surface dismisses it (the
      // backdrop-click path in openModal fires only for clicks ON the backdrop).
      position: "fixed",
      inset: "0",
      background: "transparent",
      zIndex: "2147483000",
    },
    onDismiss: () => {
      if (closeActivePopup()) return;
      modal?.close();
      if (!committed) onCancel?.();
    },
    onEnter: (e) => {
      // Enter on the picker's own secondary controls belongs to them: the month
      // arrows, Add/Remove time, the AM/PM toggle and Clear must activate, not
      // commit the whole field. A day cell still commits, so Enter on the
      // focused (and therefore selected) day is the fast path.
      const target = e.target as HTMLElement | null;
      if (
        target?.closest?.(".cm-date-picker, .cm-time-picker") &&
        !target.closest?.(".cm-date-day")
      ) {
        return;
      }
      e.preventDefault();
      if (activePopup !== null) return;
      // A combobox trigger owns Enter (it opens the listbox); committing here
      // would close the editor the user was only trying to open.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.classList.contains("cm-select-trigger")) {
        return;
      }
      commit();
    },
  }) : null;

  const surface = document.createElement("div");
  surface.className = "cm-task-field-editor";
  surface.setAttribute("role", "dialog");
  surface.setAttribute("aria-label", labels?.field ?? i18n.t(`editor.taskField.title.${kind}`));
  surface.setAttribute("data-testid", "editor.task-field-editor");
  // Set inline too, not only in the stylesheet: `computePosition`'s left/top are
  // inline and only take effect once the surface is out of normal flow, and a
  // bare test DOM never applies the imported CSS. Hosted in a pane, it flows.
  if (host === undefined) surface.style.position = "fixed";

  // The docked shape (myne-md/myne#884): the caller handed us two hosts, so the
  // controls and the actions row live in different parents and neither is wrapped
  // in a card. In every other shape both halves go inside `surface`, which is why
  // it is still created here and simply goes unused when split.
  const split = host !== undefined && host.actions !== undefined;

  const close = (): void => {
    if (modal !== null) modal.close();
    else if (split) {
      host!.body.replaceChildren();
      actions.remove();
    } else surface.remove();
  };

  const body = buildBody(kind, value, popupHost);
  if (split) {
    // In the split shape the editor OWNS both hosts: the sheet may have a field
    // list in the body from the previous step, and appending under it would leave
    // two steps on screen at once.
    //
    // The controls mount inside a `.cm-task-field-editor` WRAPPER, because that
    // is the element every control skin is scoped through and in this shape it is
    // otherwise never mounted: `surface` above is not appended, so a bare
    // `host.body.replaceChildren(body.root)` left every `.cm-task-field-editor …`
    // rule dead in the sheet and the calendar days, the select trigger and the
    // inputs all lost their skins (myne-md/myne#884 review). The wrapper is a
    // plain div and the shell supplies the card, so the docked reset rules that
    // also target this class are no-ops here.
    const card = document.createElement("div");
    card.className = "cm-task-field-editor";
    card.appendChild(body.root);
    host!.body.replaceChildren(card);
  } else surface.appendChild(body.root);

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

  if (split) host!.actions!.replaceChildren(actions);
  else surface.appendChild(actions);

  function commit(): void {
    committed = true;
    const next = body.getValue();
    close();
    onCommit(next);
  }

  commitButton.addEventListener("click", commit);
  cancelButton.addEventListener("click", () => {
    close();
    onCancel?.();
  });

  if (host !== undefined) {
    // The card wrapper belongs to the element-host shape only. Split, the caller
    // owns the chrome and a wrapper here would be an unstyleable div between the
    // two hosts.
    if (!split) host.body.replaceChildren(surface);
    // Enter commits from inside the controls, with the same listbox / date
    // carve-outs the modal path encodes.
    //
    // **Attached to a node this editor OWNS and removes, never to the caller's
    // container.** Split, that is `body.root`; hosting it on `sheet.body` instead
    // (which is what this did) outlives the editor, and the wizard reuses one
    // body across steps, so every open/Back/open cycle left a listener that
    // closed over a DEAD `body` and `commit`: one Enter then wrote the abandoned
    // field as well as the live one (myne-md/myne#884 review). The pinned actions
    // row is a sibling of `body.root`, so it is not covered here, deliberately:
    // its buttons own their own Enter.
    (split ? body.root : surface).addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest?.(".cm-date-picker, .cm-time-picker") &&
        !target.closest?.(".cm-date-day")
      ) {
        return;
      }
      if (activePopup !== null) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.classList.contains("cm-select-trigger")) {
        return;
      }
      e.preventDefault();
      commit();
    });
    body.focusTarget.focus();
  } else {
    modal!.backdrop.appendChild(surface);

    // Position after mounting so the surface has measurable dimensions. The
    // positioner owns the viewport clamp and the above/below flip. An element
    // anchor is measured live; a bare rect (the slash caret coordinate) is used
    // as-is.
    const rect =
      anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
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
    // by keyboard alone from here - Tab cycles the controls and wraps.
    modal!.installTrap(surface, body.focusTarget);
  }

  return {
    close,
    ...(host === undefined ? {} : { escape: closeActivePopup }),
  };
}
