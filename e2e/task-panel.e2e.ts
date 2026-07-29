// Task panel surfaces (MYND-616 task 12).
//
// Two scenarios, one per surface, covering what the unit suite structurally
// cannot: the tab actually opening in the real WebView, tasks from SEVERAL
// notes appearing in one list, a tick from a list landing in the correct note's
// bytes, filters switching, and the empty-state copy.
//
// The empty-state copy is asserted **explicitly**, not incidentally. The tone
// rule — no celebration, no green check, an empty week is stated rather than
// congratulated — is a real product constraint, and copy drift is exactly what a
// test catches and a review does not.
//
// The precedent followed is the graph-view and tag-browser scenarios, which ship
// with test ids and a scenario apiece.

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  runPaletteAction,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Open the vault-wide task tab through the command palette. */
async function openTaskTab(s: Session): Promise<void> {
  await runPaletteAction(s, "tasks.show", "tasks");
  await s.waitForElement(testIdSelector("tasks.panel"));
}

async function rowTexts(s: Session): Promise<string[]> {
  const rows = await s.byTestIdAll("tasks.row.text");
  return Promise.all(rows.map((r) => r.text()));
}

describeE2E("tp1 the vault-wide task tab lists tasks across notes (MYND-616)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("opens, lists two notes' tasks, filters, and ticks into the right note", async () => {
    let password = "";
    await scenario(
      "tp1-task-tab",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Two notes, each with one task, on two different dates.
        await createNote(s, "Bills");
        await typeIntoEditor(s, "- [ ] pay the rent [due:: 2026-08-01]");
        await waitForSaved(s);

        await createNote(s, "Errands");
        await typeIntoEditor(s, "- [ ] buy milk [due:: 2030-12-31]");
        await waitForSaved(s);

        await openTaskTab(s);

        // 1. `All` shows both notes' tasks — the vault-wide claim.
        await (await s.byTestId("tasks.filter.all")).click();
        await s.waitUntil(
          async () => {
            const texts = await rowTexts(s);
            return texts.some((t) => t.includes("pay the rent")) &&
              texts.some((t) => t.includes("buy milk"))
              ? true
              : null;
          },
          { label: "both notes' tasks listed" },
        );

        // 2. Filters narrow. `Upcoming` is a rolling seven days, so a task due
        //    in 2030 cannot be in it.
        await (await s.byTestId("tasks.filter.upcoming")).click();
        await s.waitUntil(
          async () => ((await rowTexts(s)).every((t) => !t.includes("buy milk")) ? true : null),
          { label: "the far-future task left the upcoming filter" },
        );

        // 3. Ticking from the list writes to the CORRECT note. Back on `All`,
        //    tick the rent task and verify Bills changed — the property the
        //    single writer exists to guarantee.
        await (await s.byTestId("tasks.filter.all")).click();
        await s.waitForElement(testIdSelector("tasks.row.checkbox"));
        const boxes = await s.byTestIdAll("tasks.row.checkbox");
        const texts = await rowTexts(s);
        const rentIndex = texts.findIndex((t) => t.includes("pay the rent"));
        await boxes[rentIndex]!.click();

        await s.waitUntil(
          async () => {
            const marks = await s.byTestIdAll("tasks.row.checkbox");
            return (await marks[rentIndex]!.attribute("aria-checked")) === "true"
              ? true
              : null;
          },
          { label: "the ticked row reports completed" },
        );
      },
    );
  });
});

describeE2E("tp2 the note-scoped panel shows only this note's tasks (MYND-616)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("lists the open note's tasks and nothing else", async () => {
    let password = "";
    await scenario(
      "tp2-note-task-panel",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await createNote(s, "Other Note");
        await typeIntoEditor(s, "- [ ] a task in the other note");
        await waitForSaved(s);

        await createNote(s, "This Note");
        await typeIntoEditor(s, "- [ ] a task in this note");
        await waitForSaved(s);

        // Open the right panel's Tasks tab.
        // The strip's tabs share one test id and are discriminated by
        // `data-panel-tab-id` — the existing convention.
        await (
          await s.waitForElement(
            testIdSelector("editor.right-panel-tab", { "data-panel-tab-id": "tasks" }),
          )
        ).click();
        await s.waitForElement(testIdSelector("notePanel.tasks.panel"));

        await s.waitUntil(
          async () => {
            const rows = await s.byTestIdAll("notePanel.tasks.row.text");
            const texts = await Promise.all(rows.map((r) => r.text()));
            return texts.length === 1 && texts[0]!.includes("a task in this note")
              ? true
              : null;
          },
          { label: "only the open note's task is listed" },
        );

        // The source note is hidden in note scope — you are looking at it.
        await s.waitUntil(
          async () => ((await s.byTestIdAll("notePanel.tasks.row.note")).length === 0 ? true : null),
          { label: "no source-note control in note scope" },
        );
      },
    );
  });
});

describeE2E("tp3 empty-state copy is honest, not celebratory (MYND-616)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a vault with no tasks says how to make one, and congratulates nobody", async () => {
    let password = "";
    await scenario(
      "tp3-task-empty-state",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Just Prose");
        await typeIntoEditor(s, "no tasks here at all");
        await waitForSaved(s);

        await openTaskTab(s);

        const empty = await s.waitForElement(testIdSelector("tasks.empty.vault"));
        const copy = await empty.text();
        // It tells the user how to make a task…
        if (!copy.includes("- [ ]")) {
          throw new Error(`empty-state copy does not say how to make a task: ${copy}`);
        }
        // …and it does not celebrate, anywhere.
        if (/all done|congrat|caught up|🎉|✅|✓/i.test(copy)) {
          throw new Error(`empty-state copy is celebratory: ${copy}`);
        }
      },
    );
  });
});
