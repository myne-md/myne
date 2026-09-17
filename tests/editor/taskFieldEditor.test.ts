// @vitest-environment jsdom
//
// The chip's editor (MYND-614 task 6).
//
// Because chips never open on caret entry (task 5), this surface is the ONLY way
// to edit these values in live mode - so "complete and fully keyboard-reachable
// from day one" is a correctness property, not polish. The tests below check that
// directly: every control focusable, Escape changes nothing, focus restored.

import { describe, expect, it, vi } from "vitest";
import {
  openTaskFieldEditor,
  PRIORITY_VALUES,
} from "@myne/editor/task-field-editor";

function anchorEl(): HTMLElement {
  const el = document.createElement("span");
  el.textContent = "2026-08-01";
  document.body.appendChild(el);
  return el;
}

function surface(): HTMLElement | null {
  return document.querySelector('[data-testid="editor.task-field-editor"]');
}

function input(): HTMLElement {
  return document.querySelector('[data-testid="editor.task-field-input"]')!;
}

describe("opens from every chip kind", () => {
  it("opens for a due field with a Myne-owned calendar picker", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "due",
      value: "2026-08-01",
      onCommit: () => {},
    });
    expect(surface()).not.toBeNull();
    // The primary control is a day button in the calendar grid, not a native
    // input (myne-md/myne#614 replaced the platform control).
    const selected = surface()!.querySelector('[data-date="2026-08-01"]')!;
    expect(selected.parentElement!.getAttribute("aria-selected")).toBe("true");
    expect(selected.getAttribute("data-testid")).toBe("editor.task-field-input");
    expect(surface()!.querySelector('[data-testid="editor.task-date-value"]')).not.toBeNull();
    handle.close();
    anchor.remove();
  });

  it("opens for a repeat field with a control, never a free-text box (dialect §3.8.7)", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "repeat",
      value: "every 3 days",
      onCommit: () => {},
    });
    // The primary control is a hand-rolled combobox, and there is NO free-text
    // rule box in the surface - a rule is assembled and serialized, never typed.
    // The only text input is the numeric step, which is a `role="spinbutton"`.
    const el = input();
    expect(el.getAttribute("role")).toBe("combobox");
    expect(el.closest(".cm-select")?.classList.contains("cm-recurrence-family")).toBe(true);
    const freeText = [...surface()!.querySelectorAll("input")].filter(
      (i) => i.type === "text" && i.getAttribute("role") !== "spinbutton",
    );
    expect(freeText.length).toBe(0);
    handle.close();
    anchor.remove();
  });

  it("seeds the recurrence control from the existing rule", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "repeat",
      value: "every 3 weeks",
      onCommit: () => {},
    });
    expect(input().getAttribute("data-value")).toBe("interval");
    expect(
      (surface()!.querySelector('[data-testid="editor.recurrence-count"]') as HTMLInputElement)
        .value,
    ).toBe("3");
    expect(
      surface()!
        .querySelector('[data-testid="editor.recurrence-unit"]')!
        .getAttribute("data-value"),
    ).toBe("week");
    handle.close();
    anchor.remove();
  });

  it("opens for a priority field with the five levels", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "priority",
      value: "high",
      onCommit: () => {},
    });
    const el = input();
    expect(el.getAttribute("role")).toBe("combobox");
    expect(el.getAttribute("data-value")).toBe("high");
    // The option roster lives in the popup, so open it to read all five.
    el.click();
    const values = [
      ...surface()!.querySelectorAll('[data-testid="editor.task-field-input-option"]'),
    ].map((option) => option.getAttribute("data-value"));
    expect(values).toEqual([...PRIORITY_VALUES]);
    handle.close();
    anchor.remove();
  });

  it("falls back to a sane priority when the source value is not one of the five", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "priority",
      value: "urgent",
      onCommit: () => {},
    });
    expect(input().getAttribute("data-value")).toBe("medium");
    handle.close();
    anchor.remove();
  });
});

describe("keyboard operation", () => {
  it("focuses the primary control on open, so the surface is usable without a mouse", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "due",
      value: "2026-08-01",
      onCommit: () => {},
    });
    expect(document.activeElement).toBe(input());
    handle.close();
    anchor.remove();
  });

  it("keeps exactly one day tabbable, plus the time and action controls", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "due",
      value: "2026-08-01",
      onCommit: () => {},
    });
    // The grid has ~35 day buttons but a roving tabindex leaves one tabbable;
    // with the month nav, the Today/Tomorrow quick picks, clear, add-time,
    // commit and cancel buttons that is nine stops.
    const tabbable = [
      ...surface()!.querySelectorAll<HTMLElement>("button, [tabindex]"),
    ].filter((el) => el.tabIndex >= 0);
    expect(tabbable.length).toBe(9);
    handle.close();
    anchor.remove();
  });

  it("commits on Enter", () => {
    const anchor = anchorEl();
    const onCommit = vi.fn();
    openTaskFieldEditor({ anchor, kind: "due", value: "2026-08-01", onCommit });

    // Pick a different day, then Enter: the modal's Enter commits whatever the
    // picker currently holds.
    surface()!.querySelector<HTMLElement>('[data-date="2026-08-15"]')!.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onCommit).toHaveBeenCalledWith("2026-08-15");
    anchor.remove();
  });

  it("commits via the button too", () => {
    const anchor = anchorEl();
    const onCommit = vi.fn();
    openTaskFieldEditor({ anchor, kind: "due", value: "2026-08-01", onCommit });

    surface()!.querySelector<HTMLElement>('[data-date="2026-08-15"]')!.click();
    (document.querySelector('[data-testid="editor.task-field-commit"]') as HTMLElement).click();

    expect(onCommit).toHaveBeenCalledWith("2026-08-15");
    anchor.remove();
  });
});

describe("the repeat control assembles canonical rules from choices", () => {
  function commitValue(value: string, drive: (root: HTMLElement) => void): string {
    const anchor = anchorEl();
    const onCommit = vi.fn();
    openTaskFieldEditor({ anchor, kind: "repeat", value, onCommit });
    drive(surface()!);
    (document.querySelector('[data-testid="editor.task-field-commit"]') as HTMLElement).click();
    anchor.remove();
    return onCommit.mock.calls[0]![0] as string;
  }

  /** Open a hand-rolled select and click the option carrying `value`. */
  function chooseOption(root: HTMLElement, testId: string, value: string): void {
    (root.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click();
    const option = root.querySelector(
      `[data-testid="${testId}-option"][data-value="${value}"]`,
    ) as HTMLElement | null;
    if (option === null) throw new Error(`no ${value} option on ${testId}`);
    option.click();
  }

  it("interval: count + unit → `every N units`", () => {
    const out = commitValue("every day", (root) => {
      chooseOption(root, "editor.task-field-input", "interval");
      const count = root.querySelector('[data-testid="editor.recurrence-count"]') as HTMLInputElement;
      count.value = "2";
      chooseOption(root, "editor.recurrence-unit", "week");
    });
    expect(out).toBe("every 2 weeks");
  });

  it("weekdays: pressed pills → normalized Monday-first set", () => {
    const out = commitValue("every day", (root) => {
      chooseOption(root, "editor.task-field-input", "weekdays");
      // Press Friday then Tuesday; the rule normalizes to Monday-first order.
      (root.querySelector('[data-testid="editor.recurrence-day-friday"]') as HTMLElement).click();
      (root.querySelector('[data-testid="editor.recurrence-day-tuesday"]') as HTMLElement).click();
    });
    // The seed pressed Monday (interval seed leaves weekdays defaulting to
    // Monday); Tuesday + Friday add to it.
    expect(out).toBe("every monday, tuesday and friday");
  });

  it("dayOfMonth: `day N of every month`", () => {
    const out = commitValue("every day", (root) => {
      chooseOption(root, "editor.task-field-input", "dayOfMonth");
      chooseOption(root, "editor.recurrence-dayofmonth", "15");
    });
    expect(out).toBe("day 15 of every month");
  });

  it("dayOfMonth last: `last day of every month`", () => {
    const out = commitValue("every day", (root) => {
      chooseOption(root, "editor.task-field-input", "dayOfMonth");
      chooseOption(root, "editor.recurrence-dayofmonth", "last");
    });
    expect(out).toBe("last day of every month");
  });

  it("ordinal: `<ordinal> <weekday> of every month`", () => {
    const out = commitValue("every day", (root) => {
      chooseOption(root, "editor.task-field-input", "ordinal");
      chooseOption(root, "editor.recurrence-ordinal", "second");
      chooseOption(root, "editor.recurrence-ordinal-weekday", "thursday");
    });
    expect(out).toBe("second thursday of every month");
  });

  it("completion-anchoring appends ` when done`", () => {
    const out = commitValue("every day", (root) => {
      (root.querySelector('[data-testid="editor.recurrence-when-done"]') as HTMLElement).click();
    });
    expect(out).toBe("every day when done");
  });

  it("round-trips an existing completion-anchored rule untouched", () => {
    const out = commitValue("every 3 days when done", () => {});
    expect(out).toBe("every 3 days when done");
  });

  // Selecting a family must leave ONLY that family's controls on screen
  // (myne-md/myne#196). This shipped broken: `syncRows()` set `hidden` and
  // nothing happened, because `.cm-recurrence-row { display: flex }` is
  // author-origin and outranks the UA stylesheet's `[hidden] { display: none }`.
  // All four families' controls rendered at once, so "every 1 days" showed
  // weekday pills and a `first`/`monday` pair underneath it.
  //
  // The assertion has to be on the inline `display`, not on `hidden`: this lane
  // applies no CSS (`vitest.config.ts` sets no `css` option), so `hidden` reads
  // `true` whether or not the row is actually off screen - which is precisely
  // why the original defect was invisible here. The real-CSS guard is the
  // scenario in `e2e/task-chips.e2e.ts`.
  const FAMILY_ROW_MARKER: ReadonlyArray<readonly [string, string]> = [
    ["interval", "editor.recurrence-count"],
    ["weekdays", "editor.recurrence-weekdays"],
    ["dayOfMonth", "editor.recurrence-dayofmonth"],
    ["ordinal", "editor.recurrence-ordinal"],
  ];

  /** The family row owning `testId` - the marker element itself, or its row. */
  function rowFor(root: HTMLElement, testId: string): HTMLElement {
    const el = root.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
    return el.classList.contains("cm-recurrence-row")
      ? el
      : (el.closest(".cm-recurrence-row") as HTMLElement);
  }

  for (const [family, marker] of FAMILY_ROW_MARKER) {
    it(`shows the ${family} row and hides the other three`, () => {
      const anchor = anchorEl();
      const handle = openTaskFieldEditor({
        anchor,
        kind: "repeat",
        value: "every day",
        onCommit: () => {},
      });
      const root = surface()!;
      chooseOption(root, "editor.task-field-input", family);

      const rows = [...root.querySelectorAll(".cm-recurrence-row")] as HTMLElement[];
      expect(rows).toHaveLength(FAMILY_ROW_MARKER.length);

      const active = rowFor(root, marker);
      expect(active.style.display).not.toBe("none");
      expect(active.hidden).toBe(false);

      for (const row of rows) {
        if (row === active) continue;
        expect(row.style.display).toBe("none");
        expect(row.hidden).toBe(true);
      }

      handle.close();
      anchor.remove();
    });
  }
});

// The controls are hand-rolled (myne-md/myne#656): a combobox + listbox, a
// spinbutton and a switch, all built from buttons / inputs so the token layer
// reaches them. "Fully keyboard-reachable" is a correctness property here
// because chips never open on caret entry - this surface is the only way to
// edit these values in live mode.
describe("the hand-rolled controls are keyboard-operable (myne-md/myne#656)", () => {
  function familyTrigger(): HTMLElement {
    return document.querySelector('[data-testid="editor.task-field-input"]') as HTMLElement;
  }
  function listbox(): HTMLElement | null {
    return document.querySelector(".cm-select-listbox");
  }
  function activeOption(): HTMLElement | null {
    return document.querySelector('.cm-select-option[data-active="true"]');
  }

  it("opens the listbox with ArrowDown and selects the active option with Enter", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "repeat",
      value: "every day",
      onCommit: () => {},
    });
    const trigger = familyTrigger();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(listbox()).not.toBeNull();
    // Focus lands ON the option, so the arrow keys drive the listbox.
    expect(activeOption()!.getAttribute("data-value")).toBe("interval");

    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(listbox()).toBeNull();
    expect(trigger.getAttribute("data-value")).toBe("interval");
    handle.close();
    anchor.remove();
  });

  it("ArrowDown / ArrowUp / Home / End move the active option", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "repeat",
      value: "every day",
      onCommit: () => {},
    });
    familyTrigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    const press = (key: string): void => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );
    };
    press("End");
    expect(activeOption()!.getAttribute("data-value")).toBe("ordinal");
    press("Home");
    expect(activeOption()!.getAttribute("data-value")).toBe("interval");
    press("ArrowDown");
    expect(activeOption()!.getAttribute("data-value")).toBe("weekdays");
    press("ArrowUp");
    expect(activeOption()!.getAttribute("data-value")).toBe("interval");
    handle.close();
    anchor.remove();
  });

  it("Escape closes the listbox only - the surface and the value are untouched", () => {
    const anchor = anchorEl();
    const onCancel = vi.fn();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "repeat",
      value: "every day",
      onCommit: () => {},
      onCancel,
    });
    const trigger = familyTrigger();
    trigger.click();
    expect(listbox()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(listbox()).toBeNull();
    expect(surface()).not.toBeNull();
    expect(trigger.getAttribute("data-value")).toBe("interval");
    expect(onCancel).not.toHaveBeenCalled();
    handle.close();
    anchor.remove();
  });

  it("the numeric step is a spinbutton: arrows step, digits type, 1..999", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "repeat",
      value: "every 2 weeks",
      onCommit: () => {},
    });
    const step = document.querySelector(
      '[data-testid="editor.recurrence-count"]',
    ) as HTMLInputElement;
    expect(step.getAttribute("role")).toBe("spinbutton");
    expect(step.getAttribute("aria-valuemin")).toBe("1");
    expect(step.getAttribute("aria-valuemax")).toBe("999");
    expect(step.getAttribute("aria-valuenow")).toBe("2");

    const arrow = (key: string): void => {
      step.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    };
    arrow("ArrowUp");
    expect(step.value).toBe("3");
    arrow("ArrowDown");
    expect(step.value).toBe("2");
    arrow("End");
    expect(step.value).toBe("999");
    arrow("ArrowUp");
    expect(step.value).toBe("999"); // clamped, not 1000
    arrow("Home");
    expect(step.value).toBe("1");
    arrow("ArrowDown");
    expect(step.value).toBe("1"); // clamped, not 0
    handle.close();
    anchor.remove();
  });

  it("the when-done control is a real button switch, toggled by activation", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "repeat",
      value: "every day",
      onCommit: () => {},
    });
    const toggle = document.querySelector(
      '[data-testid="editor.recurrence-when-done"]',
    ) as HTMLButtonElement;
    // A `<button>` activates on Space/Enter natively, which is what makes the
    // keyboard path real rather than JS-keydown-shaped.
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.click();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    toggle.click();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    handle.close();
    anchor.remove();
  });
});

describe("Escape dismisses without changing anything", () => {
  it("does not commit on Escape, even after the value was edited", () => {
    const anchor = anchorEl();
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    openTaskFieldEditor({ anchor, kind: "due", value: "2026-08-01", onCommit, onCancel });

    surface()!.querySelector<HTMLElement>('[data-date="2026-08-20"]')!.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
    expect(surface()).toBeNull();
    anchor.remove();
  });

  it("does not fire cancel after a commit", () => {
    const anchor = anchorEl();
    const onCancel = vi.fn();
    openTaskFieldEditor({
      anchor,
      kind: "due",
      value: "2026-08-01",
      onCommit: () => {},
      onCancel,
    });
    (document.querySelector('[data-testid="editor.task-field-commit"]') as HTMLElement).click();
    expect(onCancel).not.toHaveBeenCalled();
    anchor.remove();
  });

  it("the cancel button dismisses without committing", () => {
    const anchor = anchorEl();
    const onCommit = vi.fn();
    openTaskFieldEditor({ anchor, kind: "due", value: "2026-08-01", onCommit });
    (document.querySelector('[data-testid="editor.task-field-cancel"]') as HTMLElement).click();
    expect(onCommit).not.toHaveBeenCalled();
    expect(surface()).toBeNull();
    anchor.remove();
  });
});

describe("lifecycle", () => {
  it("close is idempotent", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "due",
      value: "2026-08-01",
      onCommit: () => {},
    });
    handle.close();
    expect(() => handle.close()).not.toThrow();
    expect(surface()).toBeNull();
    anchor.remove();
  });

  it("is positioned as a fixed, anchored surface rather than a centered dialog", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "due",
      value: "2026-08-01",
      onCommit: () => {},
    });
    expect(surface()!.style.position).toBe("fixed");
    expect(surface()!.style.left).not.toBe("");
    expect(surface()!.style.top).not.toBe("");
    handle.close();
    anchor.remove();
  });

  it("anchors to a bare rect, not only an element - the slash caret path", () => {
    // `/due` has no element to point at, only a `coordsAtPos` rectangle. The
    // editor must position off that just as it does off a chip.
    const handle = openTaskFieldEditor({
      anchor: { left: 120, top: 200, right: 120, bottom: 216 },
      kind: "due",
      value: "2026-08-01",
      onCommit: () => {},
    });
    expect(surface()).not.toBeNull();
    expect(surface()!.style.position).toBe("fixed");
    expect(surface()!.style.left).not.toBe("");
    expect(surface()!.style.top).not.toBe("");
    handle.close();
  });
});

// ── myne#280: an optional time, and `remind` as a fourth kind ───────────────
//
// `TaskInstant` has always been `{ date, time? }` and the writer has always
// round-tripped a time; what was missing was any way to AUTHOR one. myne#614
// then replaced the platform date/time inputs with the Myne-owned picker, so
// these drive that control instead of setting `.value` on a native input.
describe("the optional time control", () => {
  function hour(): HTMLElement {
    return document.querySelector('[data-testid="editor.task-time-hour"]')!;
  }
  function minute(): HTMLElement {
    return document.querySelector('[data-testid="editor.task-time-minute"]')!;
  }
  function addTime(): HTMLElement {
    return document.querySelector('[data-testid="editor.task-time-add"]')!;
  }
  function commitButton(): HTMLElement {
    return document.querySelector('[data-testid="editor.task-field-commit"]')!;
  }

  it("offers to add a time for due and remind", () => {
    for (const kind of ["due", "remind"] as const) {
      const anchor = anchorEl();
      const handle = openTaskFieldEditor({ anchor, kind, value: "", onCommit: () => {} });
      expect(addTime()).toBeTruthy();
      handle.close();
      anchor.remove();
    }
  });

  it("starts with no time for a date-only value, the common case", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "due",
      value: "2026-08-01",
      onCommit: () => {},
    });
    expect(document.querySelector('[data-testid="editor.task-time-hour"]')).toBeNull();
    expect(addTime()).toBeTruthy();
    handle.close();
    anchor.remove();
  });

  it("prefills from a stored time, whichever separator it uses", () => {
    for (const stored of ["2026-08-01 09:00", "2026-08-01T09:00"]) {
      const anchor = anchorEl();
      const handle = openTaskFieldEditor({
        anchor,
        kind: "due",
        value: stored,
        onCommit: () => {},
      });
      // The stored hour/minute round-trip; only the display form is localized.
      expect(Number(hour().getAttribute("aria-valuenow"))).toBe(9);
      expect(minute().getAttribute("aria-valuenow")).toBe("0");
      handle.close();
      anchor.remove();
    }
  });

  it("steps the hour with the arrow keys, wrapping at midnight", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "due",
      value: "2026-08-01 09:00",
      onCommit: () => {},
    });
    hour().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(Number(hour().getAttribute("aria-valuenow"))).toBe(8);
    hour().dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(Number(hour().getAttribute("aria-valuenow"))).toBe(12); // 00:00 in a 12h locale
    handle.close();
    anchor.remove();
  });

  it("commits a date-only value when no time was added", () => {
    const anchor = anchorEl();
    const onCommit = vi.fn();
    openTaskFieldEditor({ anchor, kind: "due", value: "2026-09-01", onCommit });
    surface()!.querySelector<HTMLElement>('[data-date="2026-09-09"]')!.click();
    commitButton().click();
    expect(onCommit).toHaveBeenCalledWith("2026-09-09");
    anchor.remove();
  });

  it("commits date + time once a time is added", () => {
    const anchor = anchorEl();
    const onCommit = vi.fn();
    openTaskFieldEditor({ anchor, kind: "remind", value: "2026-09-01", onCommit });
    surface()!.querySelector<HTMLElement>('[data-date="2026-09-09"]')!.click();
    addTime().click(); // seeds 09:00
    commitButton().click();
    expect(onCommit).toHaveBeenCalledWith("2026-09-09 09:00");
    anchor.remove();
  });

  it("commits nothing for a bare time - that is not a TaskInstant", () => {
    // A control must not be able to produce bytes the parser refuses.
    const anchor = anchorEl();
    const onCommit = vi.fn();
    openTaskFieldEditor({ anchor, kind: "due", value: "", onCommit });
    addTime().click(); // a time, but no day chosen
    commitButton().click();
    expect(onCommit).toHaveBeenCalledWith("");
    anchor.remove();
  });
});
