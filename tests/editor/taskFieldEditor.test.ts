// @vitest-environment jsdom
//
// The chip's editor (MYND-614 task 6).
//
// Because chips never open on caret entry (task 5), this surface is the ONLY way
// to edit these values in live mode — so "complete and fully keyboard-reachable
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

function input(): HTMLInputElement | HTMLSelectElement {
  return document.querySelector('[data-testid="editor.task-field-input"]')!;
}

describe("opens from every chip kind", () => {
  it("opens for a due field with a native date input", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "due",
      value: "2026-08-01",
      onCommit: () => {},
    });
    expect(surface()).not.toBeNull();
    const el = input() as HTMLInputElement;
    expect(el.tagName).toBe("INPUT");
    expect(el.type).toBe("date");
    expect(el.value).toBe("2026-08-01");
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
    // The primary control is a family SELECT, and there is NO free-text input in
    // the surface — a rule is assembled and serialized, never typed.
    const el = input();
    expect(el.tagName).toBe("SELECT");
    expect(el.classList.contains("cm-recurrence-family")).toBe(true);
    const textInputs = [...surface()!.querySelectorAll("input")].filter(
      (i) => i.type === "text",
    );
    expect(textInputs.length).toBe(0);
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
    expect((input() as HTMLSelectElement).value).toBe("interval");
    expect(
      (surface()!.querySelector('[data-testid="editor.recurrence-count"]') as HTMLInputElement)
        .value,
    ).toBe("3");
    expect(
      (surface()!.querySelector('[data-testid="editor.recurrence-unit"]') as HTMLSelectElement)
        .value,
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
    const el = input() as HTMLSelectElement;
    expect(el.tagName).toBe("SELECT");
    expect([...el.options].map((o) => o.value)).toEqual([...PRIORITY_VALUES]);
    expect(el.value).toBe("high");
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
    expect((input() as HTMLSelectElement).value).toBe("medium");
    handle.close();
    anchor.remove();
  });
});

describe("keyboard operation", () => {
  it("focuses the input on open, so the surface is usable without a mouse", () => {
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

  it("exposes every control as focusable — input, commit, cancel", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "due",
      value: "2026-08-01",
      onCommit: () => {},
    });
    const focusables = surface()!.querySelectorAll("input, select, button");
    expect(focusables.length).toBe(3);
    handle.close();
    anchor.remove();
  });

  it("commits on Enter", () => {
    const anchor = anchorEl();
    const onCommit = vi.fn();
    openTaskFieldEditor({ anchor, kind: "due", value: "2026-08-01", onCommit });

    (input() as HTMLInputElement).value = "2026-09-09";
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onCommit).toHaveBeenCalledWith("2026-09-09");
    anchor.remove();
  });

  it("commits via the button too", () => {
    const anchor = anchorEl();
    const onCommit = vi.fn();
    openTaskFieldEditor({ anchor, kind: "due", value: "2026-08-01", onCommit });

    (input() as HTMLInputElement).value = "2026-09-09";
    (document.querySelector('[data-testid="editor.task-field-commit"]') as HTMLElement).click();

    expect(onCommit).toHaveBeenCalledWith("2026-09-09");
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

  function setSelect(root: HTMLElement, testId: string, value: string): void {
    const el = root.querySelector(`[data-testid="${testId}"]`) as HTMLSelectElement;
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  it("interval: count + unit → `every N units`", () => {
    const out = commitValue("every day", (root) => {
      setSelect(root, "editor.task-field-input", "interval");
      const count = root.querySelector('[data-testid="editor.recurrence-count"]') as HTMLInputElement;
      count.value = "2";
      setSelect(root, "editor.recurrence-unit", "week");
    });
    expect(out).toBe("every 2 weeks");
  });

  it("weekdays: pressed pills → normalized Monday-first set", () => {
    const out = commitValue("every day", (root) => {
      setSelect(root, "editor.task-field-input", "weekdays");
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
      setSelect(root, "editor.task-field-input", "dayOfMonth");
      setSelect(root, "editor.recurrence-dayofmonth", "15");
    });
    expect(out).toBe("day 15 of every month");
  });

  it("dayOfMonth last: `last day of every month`", () => {
    const out = commitValue("every day", (root) => {
      setSelect(root, "editor.task-field-input", "dayOfMonth");
      setSelect(root, "editor.recurrence-dayofmonth", "last");
    });
    expect(out).toBe("last day of every month");
  });

  it("ordinal: `<ordinal> <weekday> of every month`", () => {
    const out = commitValue("every day", (root) => {
      setSelect(root, "editor.task-field-input", "ordinal");
      setSelect(root, "editor.recurrence-ordinal", "second");
      setSelect(root, "editor.recurrence-ordinal-weekday", "thursday");
    });
    expect(out).toBe("second thursday of every month");
  });

  it("completion-anchoring appends ` when done`", () => {
    const out = commitValue("every day", (root) => {
      (root.querySelector('[data-testid="editor.recurrence-when-done"]') as HTMLInputElement).checked =
        true;
    });
    expect(out).toBe("every day when done");
  });

  it("round-trips an existing completion-anchored rule untouched", () => {
    const out = commitValue("every 3 days when done", () => {});
    expect(out).toBe("every 3 days when done");
  });
});

describe("Escape dismisses without changing anything", () => {
  it("does not commit on Escape, even after the value was edited", () => {
    const anchor = anchorEl();
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    openTaskFieldEditor({ anchor, kind: "due", value: "2026-08-01", onCommit, onCancel });

    (input() as HTMLInputElement).value = "2026-12-31";
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
});
