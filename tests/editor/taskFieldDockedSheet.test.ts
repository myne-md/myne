// @vitest-environment jsdom
//
// The task-field sheet: what a client that declares the docked presentation gets
// from the `+` affordance (myne-md/myne#884).
//
// # The four things this pins that a stylesheet cannot
//
//   1. the SHEET opens rather than the two-pane popover, and the anchored client
//      still gets the two-pane popover;
//   2. the field list is a WIZARD, so choosing a field swaps the body and Back
//      returns to the list, rather than the two panes sitting side by side;
//   3. the ACTIONS row is a sibling of the scrolling body, not a child of it, so
//      a commit control cannot scroll out of reach;
//   4. the list is RE-READ after a commit, so a field just set stops being offered
//      as one to add.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getHost, setEditorHost } from "@myne/editor/host";
import { installTaskChipEditor } from "@myne/editor/decorations/task-chip-listener";
import { openTaskFieldAdd } from "@myne/editor/task-field-menu";
import { focusAt, mount, query, teardown, type Mounted } from "./_conformance";
import i18n from "../../src/i18n";

let m: Mounted | null = null;
let uninstall: (() => void) | null = null;

/** The global setup installs the shared stub with the anchored presentation;
 *  this swaps one member so both arms run against the same host otherwise. */
function installPresentation(presentation: "anchored" | "docked"): void {
  setEditorHost({ ...getHost(), floatingSurface: presentation });
}

const DOC = "- [ ] call mum\n";

beforeEach(() => {
  m = mount(DOC);
  focusAt(m, DOC.indexOf("call"));
  uninstall = installTaskChipEditor();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  if (m !== null) teardown(m);
  m = null;
  for (const id of [
    "editor.task-field-sheet",
    "editor.task-field-menu",
    "editor.task-field-editor",
  ]) {
    document.querySelectorAll(`[data-testid="${id}"]`).forEach((el) => el.parentElement?.remove());
  }
});

function openFromAddAffordance(): void {
  const add = query(m!, ".cm-task-add");
  if (add === null) throw new Error("no + affordance rendered");
  add.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}

function sheet(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="editor.task-field-sheet"]');
  if (el === null) throw new Error("no docked sheet");
  return el;
}

function inSheet(testid: string): HTMLElement {
  const el = sheet().querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  if (el === null) throw new Error(`no ${testid} inside the sheet`);
  return el;
}

function fieldRow(kind: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-testid="editor.task-field-menu-${kind}"]`,
  );
  if (el === null) throw new Error(`no ${kind} row`);
  return el;
}

describe("the docked presentation", () => {
  it("opens the sheet, not the anchored popover", () => {
    installPresentation("docked");
    openFromAddAffordance();

    expect(document.querySelector('[data-testid="editor.task-field-sheet"]')).not.toBeNull();
    expect(document.querySelector(".cm-task-field-menu")).toBeNull();
    // The scrim the caller supplied, not the transparent backdrop the anchored
    // popover uses: a full-width sheet over an undimmed page reads as broken.
    const backdrop = sheet().parentElement as HTMLElement;
    expect(backdrop.style.background).toContain("--scrim");
  });

  it("starts on the field list, with Back hidden because there is nowhere to go back to", () => {
    installPresentation("docked");
    openFromAddAffordance();

    expect(inSheet("editor.task-field-sheet-title").textContent).toBe(
      i18n.t("editor.taskField.menuTitle"),
    );
    expect(inSheet("editor.task-field-sheet-back").hidden).toBe(true);
    for (const kind of ["due", "remind", "repeat", "priority"]) {
      expect(fieldRow(kind)).not.toBeNull();
    }
  });

  it("swaps the body to the chosen field and returns to the list on Back", () => {
    installPresentation("docked");
    openFromAddAffordance();
    fieldRow("due").click();

    // Step two: the field's own editor, titled, with Back now available.
    expect(inSheet("editor.task-field-sheet-title").textContent).toBe(
      i18n.t("editor.taskField.title.due"),
    );
    expect(inSheet("editor.task-field-sheet-back").hidden).toBe(false);
    expect(inSheet("editor.task-field-input")).not.toBeNull();
    // The list is gone while a field is being edited: this is a wizard, not two
    // panes side by side.
    expect(document.querySelector('[data-testid="editor.task-field-menu-remind"]')).toBeNull();

    inSheet("editor.task-field-sheet-back").click();

    expect(inSheet("editor.task-field-sheet-title").textContent).toBe(
      i18n.t("editor.taskField.menuTitle"),
    );
    expect(fieldRow("remind")).not.toBeNull();
    expect(document.querySelector('[data-testid="editor.task-field-input"]')).toBeNull();
  });

  it("dismisses from its Close control and from a tap on the backdrop", () => {
    installPresentation("docked");
    openFromAddAffordance();
    inSheet("editor.task-field-sheet-close").click();
    expect(document.querySelector('[data-testid="editor.task-field-sheet"]')).toBeNull();

    openFromAddAffordance();
    const backdrop = sheet().parentElement as HTMLElement;
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(document.querySelector('[data-testid="editor.task-field-sheet"]')).toBeNull();
  });

  it("keeps the commit control outside the scrolling body", () => {
    installPresentation("docked");
    openFromAddAffordance();
    fieldRow("due").click();

    const body = inSheet("editor.task-field-sheet-body");
    const actions = inSheet("editor.task-field-sheet-actions");
    const commit = inSheet("editor.task-field-commit");

    expect(body.contains(commit)).toBe(false);
    expect(actions.contains(commit)).toBe(true);
  });

  it("re-reads the line after a commit, so a field just set stops being offered as addable", () => {
    installPresentation("docked");
    openFromAddAffordance();
    fieldRow("due").click();

    // The quick picks are the one-click path into the calendar, so this does not
    // depend on the wall-clock month the suite runs in.
    const today = document.querySelector<HTMLElement>(".cm-date-quick button");
    expect(today).not.toBeNull();
    today!.click();
    inSheet("editor.task-field-commit").click();

    // Back on the list, and the row now reads as an edit of an existing field
    // rather than an offer to add it.
    expect(inSheet("editor.task-field-sheet-title").textContent).toBe(
      i18n.t("editor.taskField.menuTitle"),
    );
    const dueTitle = i18n.t("editor.taskField.title.due");
    expect(fieldRow("due").textContent).toContain(
      i18n.t("editor.taskField.menuEdit", { field: dueTitle }),
    );
    // And the field really landed on the line.
    expect(m!.view.state.doc.toString()).toContain("[due::");
  });
});

describe("the anchored presentation", () => {
  it("still opens the two-pane popover and never the sheet", () => {
    installPresentation("anchored");
    openFromAddAffordance();

    expect(document.querySelector('[data-testid="editor.task-field-menu"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="editor.task-field-sheet"]')).toBeNull();
    // The anchored backdrop stays transparent: the note must stay readable beside
    // a surface that is anchored to it.
    const backdrop = document.querySelector('[data-testid="editor.task-field-menu"]')!
      .parentElement as HTMLElement;
    expect(backdrop.style.background).toBe("transparent");
  });
});

describe("the three entry points converge on one sheet", () => {
  const WITH_DUE = "- [ ] call mum [due:: 2026-08-01]\n";

  it("a tapped chip opens the same sheet, already on that field's step, with the list one Back away", () => {
    installPresentation("docked");
    teardown(m!);
    m = mount(WITH_DUE);
    focusAt(m, WITH_DUE.indexOf("call"));

    const chip = document.querySelector<HTMLElement>("[data-task-chip]");
    expect(chip).not.toBeNull();
    chip!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(sheet()).not.toBeNull();
    expect(inSheet("editor.task-field-sheet-title").textContent).toBe(
      i18n.t("editor.taskField.title.due"),
    );
    // The chip path has a list to go back to, which the anchored popover never did.
    expect(inSheet("editor.task-field-sheet-back").hidden).toBe(false);

    inSheet("editor.task-field-sheet-back").click();
    expect(fieldRow("repeat")).not.toBeNull();
  });

  it("a slash command opens the same sheet on the field it named", () => {
    installPresentation("docked");
    const lineFrom = 0;
    // The slash path anchors on a caret coordinate; jsdom answers `null` when it
    // cannot measure, so fall back to a zero rect, which the docked sheet ignores.
    const caret = m!.view.coordsAtPos(lineFrom + 6) ?? { left: 0, top: 0, right: 0, bottom: 0 };
    openTaskFieldAdd(m!.view, lineFrom, "repeat", caret);

    expect(sheet()).not.toBeNull();
    expect(document.querySelector(".cm-task-field-menu")).toBeNull();
    expect(inSheet("editor.task-field-sheet-title").textContent).toBe(
      i18n.t("editor.taskField.title.repeat"),
    );
    expect(inSheet("editor.task-field-sheet-back").hidden).toBe(false);
  });

  it("leaves the anchored chip path alone: a popover, and no list to go back to", () => {
    installPresentation("anchored");
    teardown(m!);
    m = mount(WITH_DUE);
    focusAt(m, WITH_DUE.indexOf("call"));

    const chip = document.querySelector<HTMLElement>("[data-task-chip]");
    chip!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(document.querySelector('[data-testid="editor.task-field-editor"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="editor.task-field-sheet"]')).toBeNull();
    expect(document.querySelector('[data-testid="editor.task-field-sheet-back"]')).toBeNull();
  });

  it("mounts the controls inside the card the control skins are scoped through", () => {
    // Every field control's skin is scoped `.cm-task-field-editor …` (the
    // calendar days, the select trigger, the time spinbox, the inputs). In the
    // split shape the element carrying that class is not appended, so without a
    // wrapper the sheet's controls render unstyled, and nothing here can see it:
    // jsdom computes no layout and no lane renders the docked host but a phone
    // (myne-md/myne#884 review).
    installPresentation("docked");
    openFromAddAffordance();
    fieldRow("due").click();

    const body = inSheet("editor.task-field-sheet-body");
    const card = body.querySelector(".cm-task-field-editor");
    expect(
      card,
      "the sheet body has no .cm-task-field-editor wrapper, so every skin scoped through it is dead",
    ).not.toBeNull();
    expect(card!.querySelector(".cm-date-day, .cm-select-trigger, input, select")).not.toBeNull();
  });

  it("does not commit a field the user abandoned when a later step confirms", () => {
    // The wizard reuses ONE sheet body across steps, so an editor mounted on it
    // can outlive itself if its keyboard handling is bound to that body rather
    // than to a node it removes. It was, and the failure was silent and
    // destructive: open the priority step, press Back without saving, open
    // another step, press Enter once, and the ABANDONED priority wrote its seeded
    // "medium" onto the line as well (myne-md/myne#884 review).
    //
    // The live step is DUE, whose own Enter commits nothing (no date chosen), and
    // that is fine: the discriminating assertion is the ABSENCE of the abandoned
    // step's field, and all this test needs from the live step is that it is
    // mounted so the Enter has somewhere to land.
    installPresentation("docked");
    openFromAddAffordance();
    fieldRow("priority").click();
    inSheet("editor.task-field-sheet-back").click();
    fieldRow("due").click();
    // Precondition: the due step is the one on screen, or the Enter below proves
    // nothing about which editor is live.
    expect(inSheet("editor.task-field-sheet-title").textContent).toBe(
      i18n.t("editor.taskField.title.due"),
    );

    // The split shape mounts the editor's own root INTO the sheet body, and the
    // `.cm-task-field-editor` surface is not appended at all, so the keydown is
    // dispatched from the body root and bubbles from there: what a keypress on
    // any control that is not carved out does.
    const live = inSheet("editor.task-field-sheet-body").firstElementChild as HTMLElement;
    live.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    const written = m!.view.state.doc.toString();
    expect(written, "the abandoned priority step committed its seeded value").not.toContain(
      "[priority::",
    );
  });
});
