// @vitest-environment jsdom
//
// Editing a task's fields from the task LIST (myne-md/myne#884 task 8).
//
// Its own file rather than a describe inside `taskListPanel.test.tsx`, and the
// reason is mechanical rather than organisational: `openModal` keeps an overlay
// stack MODULE-side and `trapFocus` uses it, so a case that opens a surface
// changes how the next modal in the same file focuses. Vitest gives each test
// FILE its own module registry, so a file is the isolation unit that already
// exists - and the first attempt to keep these cases in the panel's file broke
// that file's own focus test with a stale overlay. `taskFieldDockedSheet.test.ts`
// is the same shape for the surfaces themselves.
//
// The claim under test: the row's trailing control opens the SAME menu the `+`
// affordance and a chip open, in the presentation the client declared, and its
// commit writes through the injected view-free sink rather than through any
// editor document.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { TaskListPanel } from "../../src/notes/components/TaskListPanel";
import { DEFAULT_TASK_VIEW } from "../../src/notes/taskView";
import type { VaultTask } from "../../src/notes/taskIndex";
import { getHost, setEditorHost } from "@myne/editor/host";
import i18n from "@myne/editor/i18n";

const TODAY = "2026-07-28";

function task(over: Partial<VaultTask> & { noteId?: string; lineIndex?: number | null }): VaultTask {
  return {
    noteId: over.noteId ?? "n1",
    noteTitle: "Bills",
    noteFolder: null,
    lineIndex: over.lineIndex ?? 0,
    rawLine: "- [ ] pay the rent",
    completed: false,
    oversized: false,
    ...over,
  } as VaultTask;
}

function render(node: React.ReactNode): { host: HTMLElement; cleanup: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return {
    host,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const q = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector(`[data-testid="${id}"]`);
const all = (host: HTMLElement, id: string): HTMLElement[] =>
  [...host.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];

function panel(over: Partial<React.ComponentProps<typeof TaskListPanel>> = {}) {
  return (
    <TaskListPanel
      tasks={[task({ due: TODAY })]}
      view={DEFAULT_TASK_VIEW}
      today={TODAY}
      rowScope="vault"
      onViewChange={() => {}}
      {...over}
    />
  );
}

/** The white-box seam the shared test host gives every editor spec. */
function installPresentation(presentation: "anchored" | "docked"): void {
  setEditorHost({ ...getHost(), floatingSurface: presentation });
}

/**
 * Dismiss whatever surface is open, through its OWN path.
 *
 * Not merely a DOM removal: `openModal` keeps an overlay stack module-side and
 * `trapFocus` uses it, so removing a backdrop without going through `onDismiss`
 * leaves a stale entry that changes how the NEXT modal focuses. A backdrop tap is
 * the shared dismissal both presentations have, and it is what the modal listens
 * for.
 */
function dismissSurface(): void {
  for (const el of [...document.body.children]) {
    if (el.querySelector(".cm-docked-sheet, .cm-task-field-menu") !== null) {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    }
  }
}

afterEach(() => {
  installPresentation("anchored");
  dismissSurface();
  // Belt and braces: a case that failed mid-surface still leaves no backdrop
  // holding focus for the next one.
  for (const el of [...document.body.children]) {
    const stale =
      el.querySelector(".cm-docked-sheet, .cm-task-field-menu, .cm-task-field-editor") !== null ||
      el.getAttribute("tabindex") === "-1";
    if (stale) el.remove();
  }
});

describe("editing a task's fields from the list (myne-md/myne#884 task 8)", () => {
  it("carries a trailing control on every row when the client can write fields", () => {
    const { host, cleanup } = render(
      panel({
        tasks: [task({ noteId: "a", lineIndex: 0, due: TODAY }), task({ noteId: "b", lineIndex: 1 })],
        onWriteField: async () => {},
      }),
    );
    expect(all(host, "tasks.row.fields")).toHaveLength(2);
    cleanup();
  });

  it("carries no control when the client has no field write", () => {
    // The absence is the interesting half: a client that cannot write must not be
    // offered a control that does nothing.
    const { host, cleanup } = render(panel());
    expect(all(host, "tasks.row.fields")).toHaveLength(0);
    cleanup();
  });

  it("opening the control does not open the note", () => {
    const onOpen = vi.fn();
    const { host, cleanup } = render(panel({ onOpen, onWriteField: async () => {} }));
    const control = q(host, "tasks.row.fields")!;
    act(() => control.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onOpen).not.toHaveBeenCalled();
    cleanup();
  });

  it("docked: opens the sheet for that task, and commits through the injected sink", async () => {
    installPresentation("docked");
    const written: Array<{ noteId: string; lineIndex: number | null; kind: string; value: string }> =
      [];
    const { host, cleanup } = render(
      panel({
        tasks: [task({ noteId: "n1", lineIndex: 4, rawLine: "- [ ] pay the rent" })],
        onWriteField: async (t, kind, value) => {
          written.push({ noteId: t.noteId, lineIndex: t.lineIndex, kind, value });
        },
      }),
    );

    act(() =>
      q(host, "tasks.row.fields")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );

    // The sheet, with the field list on it - the same component the `+`
    // affordance and a chip open.
    const sheet = document.body.querySelector<HTMLElement>('[data-testid="editor.task-field-sheet"]');
    expect(sheet, "no docked sheet opened from the row control").not.toBeNull();
    expect(sheet!.querySelector('[data-testid="editor.task-field-menu-due"]')).not.toBeNull();

    const sheetEl = sheet!;
    act(() =>
      sheetEl
        .querySelector<HTMLElement>('[data-testid="editor.task-field-menu-due"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    // The quick picks are the one-click path into the calendar, so this does not
    // depend on the wall-clock month the suite runs in.
    const today = document.body.querySelector<HTMLElement>(".cm-date-quick button");
    expect(today).not.toBeNull();
    act(() => today!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => {
      sheetEl
        .querySelector<HTMLElement>('[data-testid="editor.task-field-commit"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The write goes through the injected sink with the record the ROW carries,
    // and the value the field editor committed.
    expect(written).toHaveLength(1);
    expect(written[0]!.noteId).toBe("n1");
    expect(written[0]!.lineIndex).toBe(4);
    expect(written[0]!.kind).toBe("due");
    expect(written[0]!.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    cleanup();
  });

  it("docked: the list re-reads the line, so a field just written reads as editable", async () => {
    installPresentation("docked");
    const { host, cleanup } = render(
      panel({
        tasks: [task({ noteId: "n1", lineIndex: 4, rawLine: "- [ ] pay the rent" })],
        onWriteField: async () => {},
      }),
    );
    act(() =>
      q(host, "tasks.row.fields")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );

    const sheet = document.body.querySelector<HTMLElement>('[data-testid="editor.task-field-sheet"]')!;
    act(() =>
      sheet
        .querySelector<HTMLElement>('[data-testid="editor.task-field-menu-due"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    act(() =>
      document.body
        .querySelector<HTMLElement>(".cm-date-quick button")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    // `await act` so the commit's microtask - the list re-read - has run by the
    // time the assertion does. A synchronous act() block would assert against the
    // pre-commit list.
    await act(async () => {
      sheet
        .querySelector<HTMLElement>('[data-testid="editor.task-field-commit"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Back on the list, and the row now reads as an EDIT of a field the line
    // carries - which is only true because the surface kept its own line current
    // from the write it just made.
    const row = sheet.querySelector<HTMLElement>('[data-testid="editor.task-field-menu-due"]');
    expect(row!.textContent).toContain(
      i18n.t("editor.taskField.menuEdit", { field: i18n.t("editor.taskField.title.due") }),
    );
    cleanup();
  });

  it("anchored: the same control opens the popover, not the sheet", () => {
    installPresentation("anchored");
    const { host, cleanup } = render(panel({ onWriteField: async () => {} }));
    act(() =>
      q(host, "tasks.row.fields")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );

    expect(document.querySelector('[data-testid="editor.task-field-menu"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="editor.task-field-sheet"]')).toBeNull();
    cleanup();
  });

  it("a refused write leaves the surface on the list and invents no line", async () => {
    // The refusal contract, at the surface: the sink rejects (the writer declined
    // because the record no longer matched the note), the sheet returns to the
    // list, and the surface's own line is UNCHANGED - so a second attempt sends
    // the writer the same line it sent the first time rather than a line the
    // surface invented from a write that never landed.
    installPresentation("docked");
    const calls: string[] = [];
    const rawLines: string[] = [];
    const { host, cleanup } = render(
      panel({
        tasks: [task({ noteId: "n1", lineIndex: 4, rawLine: "- [ ] pay the rent" })],
        onWriteField: async (t, _kind, value) => {
          calls.push(value);
          rawLines.push(t.rawLine);
          throw new Error("refused");
        },
      }),
    );
    act(() =>
      q(host, "tasks.row.fields")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    const sheet = document.body.querySelector<HTMLElement>('[data-testid="editor.task-field-sheet"]')!;
    act(() =>
      sheet
        .querySelector<HTMLElement>('[data-testid="editor.task-field-menu-due"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    act(() =>
      document.body
        .querySelector<HTMLElement>(".cm-date-quick button")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await act(async () => {
      sheet
        .querySelector<HTMLElement>('[data-testid="editor.task-field-commit"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(calls).toHaveLength(1);
    const listRow = document.body.querySelector<HTMLElement>(
      '[data-testid="editor.task-field-menu-due"]',
    );
    expect(listRow).not.toBeNull();
    expect(listRow!.textContent).not.toContain(
      i18n.t("editor.taskField.menuEdit", { field: i18n.t("editor.taskField.title.due") }),
    );

    // And a SECOND edit in the same session hands the writer the line the note
    // really carries, rather than one the surface invented from a write that
    // never landed. That is the half a sink which only REPORTS the failure
    // cannot hold: it is the same defect one commit later.
    act(() => listRow!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() =>
      document.body
        .querySelector<HTMLElement>(".cm-date-quick button")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await act(async () => {
      sheet
        .querySelector<HTMLElement>('[data-testid="editor.task-field-commit"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(rawLines).toEqual(["- [ ] pay the rent", "- [ ] pay the rent"]);
    cleanup();
  });

  it("does not offer the control on a row whose write cannot succeed", () => {
    // A note-task has no line to rewrite and an over-cap record's raw line is
    // truncated, so either would open the menu, commit, and refuse behind a
    // console.warn. Offering a control that quietly does nothing is worse than
    // not offering one.
    const { host, cleanup } = render(
      panel({
        tasks: [
          task({ noteId: "note-task", lineIndex: null, rawLine: "" }),
          task({ noteId: "n2", lineIndex: 1, oversized: true }),
          task({ noteId: "n3", lineIndex: 2 }),
        ],
        onWriteField: async () => {},
      }),
    );
    expect(all(host, "tasks.row.fields")).toHaveLength(1);
    cleanup();
  });
});
