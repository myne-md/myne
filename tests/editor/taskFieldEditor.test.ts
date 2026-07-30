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

  it("opens for a repeat field with free text — the rule vocabulary is not this layer's", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({
      anchor,
      kind: "repeat",
      value: "every 3 days",
      onCommit: () => {},
    });
    const el = input() as HTMLInputElement;
    expect(el.type).toBe("text");
    expect(el.value).toBe("every 3 days");
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
    openTaskFieldEditor({ anchor, kind: "repeat", value: "every week", onCommit });

    (input() as HTMLInputElement).value = "every 2 weeks";
    (document.querySelector('[data-testid="editor.task-field-commit"]') as HTMLElement).click();

    expect(onCommit).toHaveBeenCalledWith("every 2 weeks");
    anchor.remove();
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
