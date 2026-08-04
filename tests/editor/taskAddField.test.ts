// @vitest-environment jsdom
//
// The add-a-task-field entry points: the cursor-gated `+` affordance, its
// three-way menu, and the `/due` `/repeat` `/priority` slash commands.
//
// These exist so a user never types `[due:: …]` by hand. The write path is NOT
// new — every route converges on the same tracked begin/apply seam a chip edit
// uses (`taskChipWiring.test.ts` covers that seam directly). What is new, and
// what these cover, is: the `+` shows only on the caret's task line; the menu
// adds an absent field and edits a present one; and the slash commands add a
// field, auto-converting a non-task line first.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTaskChipEditor } from "@myne/editor/decorations/task-chip-listener";
import { slashCommands } from "../../src/editor/slash/commands";
import {
  focusAt,
  mount,
  type Mounted,
  query,
  queryAll,
  teardown,
} from "./_conformance";

let m: Mounted | null = null;
let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
  if (m !== null) teardown(m);
  m = null;
  // Tear down any modal (menu / field editor) an assertion left open — each
  // mounts under an `openModal` backdrop appended to <body>.
  for (const id of ["editor.task-field-menu", "editor.task-field-editor"]) {
    document
      .querySelectorAll(`[data-testid="${id}"]`)
      .forEach((el) => el.parentElement?.remove());
  }
});

function addButton(): HTMLElement {
  const el = query(m!, ".cm-task-add");
  if (el === null) throw new Error("no + affordance rendered");
  return el as HTMLElement;
}

function menuRow(kind: string): HTMLElement {
  const el = document.querySelector(`[data-testid="editor.task-field-menu-${kind}"]`);
  if (el === null) throw new Error(`no ${kind} menu row`);
  return el as HTMLElement;
}

function fieldInput(): HTMLInputElement | HTMLSelectElement {
  return document.querySelector('[data-testid="editor.task-field-input"]')!;
}

function commit(): void {
  (document.querySelector('[data-testid="editor.task-field-commit"]') as HTMLElement).click();
}

describe("the + affordance appears only on the caret's task line", () => {
  it("renders at the end of a focused task line", () => {
    m = mount("- [ ] pay the rent\nplain prose\n");
    focusAt(m, 5);
    expect(queryAll(m, ".cm-task-add").length).toBe(1);
  });

  it("disappears when the caret leaves the task line", () => {
    m = mount("- [ ] pay the rent\nplain prose\n");
    focusAt(m, 5);
    expect(queryAll(m, ".cm-task-add").length).toBe(1);
    focusAt(m, m.view.state.doc.line(2).from + 2); // onto the prose line
    expect(queryAll(m, ".cm-task-add").length).toBe(0);
  });

  it("never renders on a non-task line", () => {
    m = mount("just prose here\n");
    focusAt(m, 3);
    expect(queryAll(m, ".cm-task-add").length).toBe(0);
  });
});

function openMenu(doc: string): void {
  m = mount(doc);
  focusAt(m, 5);
  cleanup.push(installTaskChipEditor());
  addButton().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

describe("the + menu adds an absent field and edits a present one", () => {
  it("opens the three-way menu on activation", () => {
    openMenu("- [ ] pay the rent\n");
    expect(document.querySelector('[data-testid="editor.task-field-menu"]')).not.toBeNull();
    expect(menuRow("due")).not.toBeNull();
    expect(menuRow("repeat")).not.toBeNull();
    expect(menuRow("priority")).not.toBeNull();
  });

  it("a row for an ABSENT field opens an empty editor (add)", () => {
    openMenu("- [ ] pay the rent\n");
    menuRow("due").click();
    expect((fieldInput() as HTMLInputElement).value).toBe("");
  });

  it("a row for a PRESENT field prefills its source value (edit, not clobber)", () => {
    openMenu("- [ ] pay the rent [due:: 2026-08-01]\n");
    menuRow("due").click();
    expect((fieldInput() as HTMLInputElement).value).toBe("2026-08-01");
  });

  it("adding a due field through the menu lands it in the document", () => {
    openMenu("- [ ] pay the rent\n");
    menuRow("due").click();
    (fieldInput() as HTMLInputElement).value = "2026-09-09";
    commit();
    expect(m!.view.state.doc.toString()).toContain("[due:: 2026-09-09]");
  });

  it("still offers both rows on an anchorless repeat rule (myne#197)", () => {
    // The rule renders as unread there, which is the point — but the menu is
    // the way OUT of that state, so it must keep offering the repeat row (to
    // edit the rule) and the due row (to give it a date). It keys on which
    // fields the line carries, not on whether they typed, and this pins that.
    openMenu("- [ ] shower [repeat:: every day]\n");
    expect(menuRow("repeat")).not.toBeNull();
    expect(menuRow("due")).not.toBeNull();
    menuRow("repeat").click();
    // Prefilled with the SOURCE value, so opening it does not clobber the rule.
    expect((fieldInput() as HTMLSelectElement).value).toBe("interval");
  });
});

describe("the + menu's skip row (myne#198)", () => {
  // Skip advances from today, so the date is pinned — the menu reads the system
  // clock because that is what production does.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 28, 12, 0, 0)); // 2026-07-28, local
  });
  afterEach(() => vi.useRealTimers());

  const skipRow = () => document.querySelector('[data-testid="editor.task-field-menu-skip"]');

  it("offers skip on a line whose rule can actually be advanced", () => {
    openMenu("- [ ] water plants [due:: 2026-07-01] [repeat:: every 3 days]\n");
    expect(skipRow()).not.toBeNull();
  });

  it("does not offer it on a task with no repeat rule", () => {
    openMenu("- [ ] pay the rent [due:: 2026-08-01]\n");
    expect(skipRow()).toBeNull();
  });

  it("does not offer it for a rule Myne cannot read", () => {
    // The test is "can this occurrence be skipped", not "is there a repeat
    // field" — an action that would silently do nothing is exactly the failure
    // the chip layer forbids itself.
    openMenu("- [ ] x [due:: 2026-07-01] [repeat:: every fortnight]\n");
    expect(skipRow()).toBeNull();
  });

  it("does not offer it when the rule has no anchor date (myne#197's case)", () => {
    openMenu("- [ ] shower [repeat:: every day]\n");
    expect(skipRow()).toBeNull();
  });

  it("advances the line IN PLACE, adding no line and no completion field", () => {
    openMenu("- [ ] water plants [due:: 2026-07-01] [repeat:: every 3 days]\n");
    (skipRow() as HTMLElement).click();

    const text = m!.view.state.doc.toString();
    expect(text.split("\n").length).toBe(2); // one task line + the trailing newline
    expect(text).toContain("[repeat:: every 3 days]");
    expect(text).not.toContain("[due:: 2026-07-01]");
    expect(text).not.toContain("done::");
    expect(text).toMatch(/^- \[ \]/); // still unticked: it did not happen
  });

  it("closes the menu on skip", () => {
    openMenu("- [ ] water plants [due:: 2026-07-01] [repeat:: every 3 days]\n");
    (skipRow() as HTMLElement).click();
    expect(document.querySelector('[data-testid="editor.task-field-menu"]')).toBeNull();
  });
});

describe("/due /repeat /priority slash commands", () => {
  const cmd = (id: string) => slashCommands().find((c) => c.id === id)!;

  it("registers the three commands", () => {
    expect(cmd("due")).toBeDefined();
    expect(cmd("repeat")).toBeDefined();
    expect(cmd("priority")).toBeDefined();
  });

  it("/due on a task line removes the trigger, opens the editor, and commits", () => {
    m = mount("- [ ] pay rent /due\n");
    const from = m.view.state.doc.toString().indexOf("/due");
    cmd("due").apply(m.view, from, from + "/due".length);
    // Trigger gone; still a task line, so no `- [ ] ` was prepended.
    expect(m.view.state.doc.toString()).toBe("- [ ] pay rent \n");
    (fieldInput() as HTMLInputElement).value = "2026-10-10";
    commit();
    expect(m.view.state.doc.toString()).toContain("[due:: 2026-10-10]");
  });

  it("/due on a NON-task line auto-prefixes '- [ ] ' first", () => {
    m = mount("pay rent /due\n");
    const from = m.view.state.doc.toString().indexOf("/due");
    cmd("due").apply(m.view, from, from + "/due".length);
    expect(m.view.state.doc.toString().startsWith("- [ ] pay rent")).toBe(true);
    (fieldInput() as HTMLInputElement).value = "2026-10-10";
    commit();
    const text = m.view.state.doc.toString();
    expect(text).toContain("- [ ] pay rent");
    expect(text).toContain("[due:: 2026-10-10]");
  });

  it("/repeat opens the recurrence control, never a free-text box", () => {
    m = mount("- [ ] water plants /repeat\n");
    const from = m.view.state.doc.toString().indexOf("/repeat");
    cmd("repeat").apply(m.view, from, from + "/repeat".length);
    const input = fieldInput();
    expect(input.tagName).toBe("SELECT");
    expect(input.classList.contains("cm-recurrence-family")).toBe(true);
  });
});

// ── myne#276: an anchorless repeat is explained, not silently minted ─────────
//
// #197 taught the chip layer to withhold the chip from a rule with nothing to
// repeat FROM — correct, and the half that shipped. The half that did not is
// this one: the menu still offered **Repeat** on a bare task line with no
// warning of any kind, and the only explanation for the raw text that followed
// was a `title=` tooltip on the exact field span. From the user's side the whole
// signal was "the chip didn't appear", which reads as a parser bug.
describe("an anchorless repeat explains itself (myne#276)", () => {
  const repeatNote = () =>
    document.querySelector('[data-testid="editor.task-field-menu-repeat-note"]');

  it("marks the Repeat row as needing a date on an anchorless line", () => {
    openMenu("- [ ] pay the rent\n");
    expect(repeatNote()).not.toBeNull();
    expect(repeatNote()!.textContent).toBeTruthy();
  });

  it("does not mark it when the line already carries a due date", () => {
    openMenu("- [ ] pay the rent [due:: 2026-08-01]\n");
    expect(repeatNote()).toBeNull();
  });

  it("does not mark it when the line carries a remind date", () => {
    openMenu("- [ ] pay the rent [remind:: 2026-08-01]\n");
    expect(repeatNote()).toBeNull();
  });

  it("offers the due date in the same surface after an anchorless repeat commits", () => {
    openMenu("- [ ] pay the rent\n");
    menuRow("repeat").click();
    (fieldInput() as HTMLSelectElement).value = "interval";
    fieldInput().dispatchEvent(new Event("change", { bubbles: true }));
    commit();

    // The rule the user chose is written — it is correct, and refusing it would
    // discard it…
    expect(m!.view.state.doc.toString()).toContain("[repeat::");
    // …and the anchor it needs is asked for straight away, in the same surface.
    const chained = document.querySelector('[data-testid="editor.task-field-editor"]');
    expect(chained).not.toBeNull();
    // It is the DUE editor, not the repeat one that just closed: the repeat
    // surface leads with a family `<select>`, the due surface with a text input.
    expect(chained!.getAttribute("aria-label")).toBe("Due date");
    expect(fieldInput().tagName).toBe("INPUT");
  });

  it("does not chain into the due editor when the line already has an anchor", () => {
    openMenu("- [ ] pay the rent [due:: 2026-08-01]\n");
    menuRow("repeat").click();
    (fieldInput() as HTMLSelectElement).value = "interval";
    fieldInput().dispatchEvent(new Event("change", { bubbles: true }));
    commit();
    expect(document.querySelector('[data-testid="editor.task-field-editor"]')).toBeNull();
  });
});

// ── myne#280: `remind` in the add menu and the slash roster ─────────────────
describe("remind is authorable (myne#280)", () => {
  it("appears as a menu row", () => {
    openMenu("- [ ] call mother\n");
    expect(menuRow("remind")).not.toBeNull();
  });

  it("writes a reminder with a time through the menu", () => {
    openMenu("- [ ] call mother\n");
    menuRow("remind").click();
    (fieldInput() as HTMLInputElement).value = "2026-09-09";
    (document.querySelector('[data-testid="editor.task-field-time"]') as HTMLInputElement).value =
      "09:00";
    commit();
    expect(m!.view.state.doc.toString()).toContain("[remind:: 2026-09-09 09:00]");
  });

  it("satisfies the repeat anchor, so no due date is chained after it", () => {
    openMenu("- [ ] call mother [remind:: 2026-09-09]\n");
    expect(
      document.querySelector('[data-testid="editor.task-field-menu-repeat-note"]'),
    ).toBeNull();
  });

  it("is offered as a slash command", () => {
    const ids = slashCommands().map((c) => c.id);
    expect(ids).toContain("remind");
  });
});
