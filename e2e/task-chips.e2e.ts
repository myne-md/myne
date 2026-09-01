// Task-field chips in the editor (MYND-614 task 12).
//
// Covers what the unit suite structurally cannot: the chips rendering in the real
// WebView, the field editor opening from one, a value change landing in the
// FILE, and the keyboard path. The unit tests already pin the mechanics
// (atomic-range equality, widget identity, live click resolution, malformed
// handling); this scenario proves the whole path holds end to end.
//
// The precedent followed is the table and tag-chip decorations, which ship with
// test ids and a scenario. The diagram decoration shipped with neither — that is
// deliberately NOT the precedent copied here.

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  ESCAPE_KEY,
  closeSettings,
  createNote,
  dismissImporterOffer,
  editorText,
  editorSourceText,
  openSettings,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** A task line carrying all three chippable fields. */
const TASK_LINE =
  " pay the rent [due:: 2026-08-01] [repeat:: every month] [priority:: high]";

async function chipCount(s: Session, kind: string): Promise<number> {
  return (await s.byTestIdAll(`editor.task-chip-${kind}`)).length;
}

describeE2E("tc1 task-field chips render, open, and write (MYND-614)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("renders all three chips, edits one, and lands the change in the file", async () => {
    let password = "";
    await scenario(
      "tc1-task-chips",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Task Note");

        await typeIntoEditor(s, `- [ ]${TASK_LINE}`, { landedText: "pay the rent" });
        await waitForSaved(s);

        // 1. All three chips render in live mode.
        await s.waitForElement(testIdSelector("editor.task-chip-due"));
        await s.waitUntil(
          async () => ((await chipCount(s, "due")) === 1 ? true : null),
          { label: "one due chip" },
        );
        await s.waitUntil(
          async () => ((await chipCount(s, "repeat")) === 1 ? true : null),
          { label: "one repeat chip" },
        );
        await s.waitUntil(
          async () => ((await chipCount(s, "priority")) === 1 ? true : null),
          { label: "one priority chip" },
        );

        // 2. Clicking a chip opens the field editor. The `due` editor is a
        //    native `<input type="date">`, so this proves the OPEN path for the
        //    one field whose control is a platform widget.
        await (await s.byTestId("editor.task-chip-due")).click();
        await s.waitForElement(testIdSelector("editor.task-field-editor"));
        // Escape goes to the FIELD INPUT, which is what holds focus while the
        // editor is open — `.cm-content` is not focusable then (tc2's pattern).
        await (await s.byTestId("editor.task-field-input")).sendKeys(ESCAPE_KEY);
        await s.waitForGone(testIdSelector("editor.task-field-editor"));

        // 3. A value change lands in the FILE — the point of the whole path.
        //    Driven through `repeat`, whose editor is a CONTROL, not a text box
        //    (dialect §3.8.7: a rule is chosen from a control, never typed). The
        //    seed rule `every month` opens the interval family; bumping the
        //    interval count to 3 and committing must serialize canonical
        //    `every 3 months` into the file — the control → canonical-English →
        //    write path, end to end. The count is a number input, so it takes
        //    real keystrokes honestly (a native `<select>` would be asserting on
        //    the platform's dropdown, the trap the old text-input note called
        //    out for the date widget).
        await (await s.byTestId("editor.task-chip-repeat")).click();
        await s.waitForElement(testIdSelector("editor.task-field-editor"));
        const count = await s.byTestId("editor.recurrence-count");
        await count.replaceText("3");
        await (await s.byTestId("editor.task-field-commit")).click();
        await waitForSaved(s);

        await s.waitUntil(
          async () => ((await editorText(s)).includes("every 3 months") ? true : null),
          { label: "assembled rule reached the document" },
        );
      },
    );
  });
});

describeE2E("tc2 chip editor dismissal leaves the value alone (MYND-614)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("Escape closes the editor without changing anything", async () => {
    let password = "";
    await scenario(
      "tc2-task-chip-escape",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Escape Note");

        await typeIntoEditor(s, "- [ ] pay the rent [due:: 2026-08-01]", {
          landedText: "pay the rent",
        });
        await waitForSaved(s);
        await s.waitForElement(testIdSelector("editor.task-chip-due"));

        await (await s.byTestId("editor.task-chip-due")).click();
        await s.waitForElement(testIdSelector("editor.task-field-editor"));

        // Escape is U+E00C in the WebDriver key table. Typing a literal "Escape"
        // would insert the word — the invisible-key trap this suite has hit
        // before.
        await (await s.byTestId("editor.task-field-input")).sendKeys("\uE00C");

        // SOURCE text, not the rendered text. The chip is a replace widget and
        // since myne-md/myne#609 its label is the reader's chosen format, so the
        // ISO date is no longer anywhere in the render. Reading it there was how
        // this assertion used to pass, and it is what makes the property being
        // asserted (the bytes did not move) worth asserting at all.
        await s.waitUntil(
          async () => ((await editorSourceText(s)).includes("2026-08-01") ? true : null),
          { label: "value unchanged after Escape" },
        );
      },
    );
  });
});

describeE2E("tc3 the + affordance adds a task field end to end", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("opens the add menu on a fieldless task line and lands a new field in the file", async () => {
    let password = "";
    await scenario(
      "tc3-task-add-field",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Add Field Note");

        // A task line carrying NO fields yet. The caret stays on it after typing,
        // so the cursor-gated `+` affordance renders — the entry point that lets
        // a field be added without typing `[repeat:: …]` by hand.
        await typeIntoEditor(s, "- [ ] pay the rent", { landedText: "pay the rent" });
        await waitForSaved(s);

        // 1. The `+` affordance renders on the caret's task line.
        await s.waitForElement(testIdSelector("editor.task-add-field"));

        // 2. Activating it opens the three-way add menu.
        await (await s.byTestId("editor.task-add-field")).click();
        await s.waitForElement(testIdSelector("editor.task-field-menu"));

        // 3. Pick "Repeat". Its editor is a CONTROL (the recurrence builder), so
        //    it drives honestly through a number input — the same reason tc1
        //    exercises the write path through `repeat` rather than the native
        //    date widget. On a fieldless line this opens at the default (weekly),
        //    so bumping the interval count to 3 and committing must APPEND a
        //    canonical `[repeat:: every 3 weeks]` — the add path (no prior field)
        //    writing through the very seam a chip edit uses, end to end.
        await (await s.byTestId("editor.task-field-menu-repeat")).click();
        await s.waitForElement(testIdSelector("editor.task-field-editor"));

        // 3a. Only the ACTIVE family's controls may be on screen — the builder
        //     opens on the interval family, so the weekday-family row must be
        //     collapsed (myne-md/myne#196). This assertion exists HERE and not in
        //     the unit lane because the defect was a cascade override — the
        //     author-origin `.cm-recurrence-row { display: flex }` beating the UA
        //     stylesheet's `[hidden]` rule — and jsdom applies no CSS, so a unit
        //     test reads the attribute as set whether or not the row is visible.
        //     A zero-area rect is real-CSS proof of collapse rather than of
        //     intent. Shipped broken: all four families rendered at once, so
        //     "every 1 days" showed weekday pills and a `first`/`monday` pair
        //     under it.
        //     Measured through `execute`, not `Element.rect()`: WebDriver's Get
        //     Element Rect refuses a `display: none` element outright
        //     ("element not interactable"), so the very state this asserts is
        //     the one it cannot report. Reading `getBoundingClientRect` in the
        //     page keeps the real-CSS proof the assertion is for.
        await s.byTestId("editor.recurrence-weekdays"); // the row exists…
        await s.waitUntil(
          async () => {
            const box = await s.execute<{ width: number; height: number } | null>(
              `const el = document.querySelector(arguments[0]);
               if (el === null) return null;
               const r = el.getBoundingClientRect();
               return { width: r.width, height: r.height };`,
              [testIdSelector("editor.recurrence-weekdays")],
            );
            return box !== null && box.width === 0 && box.height === 0 ? true : null;
          },
          { label: "inactive weekday-family row is collapsed, not merely hidden" },
        );

        const count = await s.byTestId("editor.recurrence-count");
        await count.replaceText("3");
        await (await s.byTestId("editor.task-field-commit")).click();
        await waitForSaved(s);

        await s.waitUntil(
          async () => ((await editorText(s)).includes("[repeat:: every 3 weeks]") ? true : null),
          { label: "added repeat rule reached the document" },
        );
      },
    );
  });
});

describeE2E("tc4 the chosen date format reaches the chip (myne-md/myne#609)", () => {
  // Vault-count precondition: 1 (weak KDF).
  //
  // What the unit suite structurally cannot answer: whether the SETTING the user
  // picks in the real Settings panel arrives at the decoration builder at all.
  // The unit tests publish into the display store directly, so they prove the
  // formatter is wired to the store and say nothing about whether the store is
  // wired to the preference. That gap is the whole of myne-md/myne#609: every
  // formatting surface read a store that, on one client, nothing ever wrote to.
  it("renders a due chip in the picked format while the file keeps its bytes", async () => {
    let password = "";
    await scenario(
      "tc4-chip-date-format",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Format Note");

        await typeIntoEditor(s, "- [ ] pay the rent [due:: 2026-08-01]", {
          landedText: "pay the rent",
        });
        await waitForSaved(s);
        await s.waitForElement(testIdSelector("editor.task-chip-due"));

        // Pick day-first explicitly rather than asserting the default. The
        // default is the `system` preset, whose output is the platform's to
        // choose, so asserting it would test `Intl` rather than the wiring.
        await openSettings(s, "editor");
        await (await s.byTestId("settings.date-format-dmy")).click();
        await closeSettings(s);

        await s.waitUntil(
          async () => {
            const chips = await s.byTestIdAll("editor.task-chip-due");
            const text = chips.length === 1 ? await chips[0]!.textContent() : "";
            return text.trim() === "01/08/2026" ? true : null;
          },
          { label: "due chip renders in the chosen day-first format" },
        );

        // And the other half of the value/label split: the label moved, the
        // bytes did not. A formatted label reaching a write is the one failure
        // this feature must never produce, and the file is where that shows.
        // SOURCE text, not the rendered text. The chip is a replace widget and
        // since myne-md/myne#609 its label is the reader's chosen format, so the
        // ISO date is no longer anywhere in the render. Reading it there was how
        // this assertion used to pass, and it is what makes the property being
        // asserted (the bytes did not move) worth asserting at all.
        await s.waitUntil(
          async () => ((await editorSourceText(s)).includes("[due:: 2026-08-01]") ? true : null),
          { label: "the stored civil date is untouched" },
        );
      },
    );
  });
});

describeE2E("tc5 the chip repaints while Settings is still open (myne-md/myne#609)", () => {
  // Vault-count precondition: 1 (weak KDF).
  //
  // **The modal stays OPEN, and that is the whole scenario.** Closing Settings
  // returns focus to the editor, and the shared rebuild gate has always watched
  // `focusChanged`, so a scenario that closed the modal first would pass with
  // the ambient-refresh plugin deleted. That is not a hypothetical: it is why
  // tc4 above, which does close the modal, cannot be the coverage for this.
  // Asserting under the open modal leaves the ambient effect as the only thing
  // that can explain a changed label.
  it("changes the rendered date with no edit, no scroll and no focus change", async () => {
    let password = "";
    await scenario(
      "tc5-chip-repaint-live",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Repaint Note");

        await typeIntoEditor(s, "- [ ] pay the rent [due:: 2026-08-01]", {
          landedText: "pay the rent",
        });
        await waitForSaved(s);

        await openSettings(s, "editor");
        await (await s.byTestId("settings.date-format-iso")).click();

        const chipText = async (): Promise<string> => {
          const chips = await s.byTestIdAll("editor.task-chip-due");
          return chips.length === 1 ? (await chips[0]!.textContent()).trim() : "";
        };
        await s.waitUntil(
          async () => ((await chipText()) === "2026-08-01" ? true : null),
          { label: "chip settled on the ISO baseline before the change under test" },
        );

        // The only action between the two reads. The modal is still up, the
        // caret has not moved, the document has not changed, nothing scrolled.
        await (await s.byTestId("settings.date-format-dmy")).click();

        await s.waitUntil(
          async () => ((await chipText()) === "01/08/2026" ? true : null),
          { label: "chip repainted under the open modal" },
        );

        await closeSettings(s);
        // SOURCE text, not the rendered text. The chip is a replace widget and
        // since myne-md/myne#609 its label is the reader's chosen format, so the
        // ISO date is no longer anywhere in the render. Reading it there was how
        // this assertion used to pass, and it is what makes the property being
        // asserted (the bytes did not move) worth asserting at all.
        await s.waitUntil(
          async () => ((await editorSourceText(s)).includes("[due:: 2026-08-01]") ? true : null),
          { label: "the stored civil date is untouched" },
        );
      },
    );
  });
});
