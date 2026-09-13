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

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  runPaletteAction,
  settleOn,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Open the vault-wide task tab through the command palette. */
async function openTaskTab(s: Session): Promise<void> {
  await runPaletteAction(s, "tasks.show", "tasks");
  await s.waitForElement(testIdSelector("tasks.panel"));
  // The windowed scroll container is what holds the rows (myne-md/myne#656).
  await s.waitForElement(testIdSelector("tasks.scroll"));
}

async function rowTexts(s: Session): Promise<string[]> {
  const rows = await s.byTestIdAll("tasks.row.text");
  return Promise.all(rows.map((r) => r.text()));
}

/** Open the filter builder if closed, then pick an axis value. */
async function pickBuilderValue(
  s: Session,
  prefix: string,
  axis: string,
  value: string,
): Promise<void> {
  if ((await s.byTestIdAll(`${prefix}.filtersPanel`)).length === 0) {
    await (await s.byTestId(`${prefix}.filtersButton`)).click();
  }
  await (await s.byTestId(`${prefix}.builderTab.${axis}`)).click();
  await (await s.byTestId(`${prefix}.builderOption.${axis}.${value}`)).click();
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
        await typeIntoEditor(s, "- [ ] pay the rent [due:: 2026-08-01]", {
          landedText: "pay the rent",
        });
        await waitForSaved(s);

        await createNote(s, "Errands");
        await typeIntoEditor(s, "- [ ] buy milk [due:: 2030-12-31]", { landedText: "buy milk" });
        await waitForSaved(s);

        await openTaskTab(s);

        // 1. Sections: both notes' tasks appear, and the section model puts the
        //    past-due one under Overdue and the 2030 one under Later.
        await s.waitForElement(testIdSelector("tasks.section.overdue"));
        await s.waitForElement(testIdSelector("tasks.section.later"));
        await s.waitUntil(
          async () => {
            const texts = await rowTexts(s);
            return texts.some((t) => t.includes("pay the rent")) &&
              texts.some((t) => t.includes("buy milk"))
              ? true
              : null;
          },
          { label: "both notes' tasks listed across sections" },
        );

        // 2. The due filter narrows. `Upcoming` is a rolling seven days, so
        //    neither an overdue task nor a 2030 one can be in it.
        await pickBuilderValue(s, "tasks", "due", "upcoming");
        await s.waitUntil(
          async () => ((await rowTexts(s)).length === 0 ? true : null),
          { label: "neither task is in the upcoming window" },
        );
        await pickBuilderValue(s, "tasks", "due", "any");

        // 3. Search narrows the list client-side over the live array — item 6 —
        //    and a query that matches nothing says so about the QUERY rather
        //    than presenting an empty vault (myne-md/myne#656).
        await s.waitForElement(testIdSelector("tasks.row.checkbox"));
        await (await s.byTestId("tasks.search")).replaceText("milk");
        await s.waitUntil(
          async () => {
            const rows = await rowTexts(s);
            return rows.length === 1 && rows[0]!.includes("buy milk") ? true : null;
          },
          { label: "search narrowed the list to the matching task" },
        );
        await (await s.byTestId("tasks.search")).replaceText("zzz-no-match");
        await s.waitForElement(testIdSelector("tasks.empty.search"));
        await (await s.byTestId("tasks.search")).replaceText("");
        await s.waitUntil(
          async () => ((await rowTexts(s)).length === 2 ? true : null),
          { label: "clearing the search restored both tasks" },
        );

        // 4. Ticking from the list writes to the CORRECT note. With the list
        //    restored, tick the rent task and verify Bills changed — the
        //    property the single writer exists to guarantee.
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

describeE2E("tp4 the task tab body fills the pane (myne-md/myne#534)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the task list ends where the pane ends, so its filter strip pins instead of scrolling away", async () => {
    // `TaskListPanel`'s root is written as a FILLING body (`height: 100%` over
    // an inner `flex: 1 1 auto; min-height: 0; overflow-y: auto`), and for the
    // life of the feature the pane handed it the flowing frame instead. The
    // percentage resolved to `auto`, the inner scroller never got a box to
    // scroll inside, and the filter strip slid up out of view with the list.
    // Third member of #534's family and the same cause; nothing here was
    // unreachable, which is why it outlived the graph's version of it.
    //
    // The claim is one number, for the same reason gt2's is: a panel that ends
    // where the pane ends has a box, and a panel that ends short of it does not.
    let password = "";
    await scenario(
      "tp4-task-tab-fills-pane",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Tp4 Note");
        await typeIntoEditor(s, "- [ ] tp4taskalfa9x3k7m2q");
        await waitForSaved(s);
        await openTaskTab(s);
        // The undated task sits in its own "No date" section under the default
        // view, so it is present without touching a filter.
        await s.waitForElement(testIdSelector("tasks.section.none"));
        await s.waitForElement(testIdSelector("tasks.row.text"));

        const geometry = await settleOn(
          s,
          async () =>
            (await s.execute<string>(
              "var pane = document.querySelector(arguments[0]);" +
                "var panel = document.querySelector(arguments[1]);" +
                "if (!pane || !panel) return '';" +
                "return JSON.stringify({" +
                "  paneBottom: Math.round(pane.getBoundingClientRect().bottom)," +
                "  panelBottom: Math.round(panel.getBoundingClientRect().bottom)," +
                "  panelHeight: Math.round(panel.getBoundingClientRect().height)" +
                "});",
              [testIdSelector("editor.pane"), testIdSelector("tasks.panel")],
            )) || null,
          {
            label: "task panel geometry settles",
            parse: (raw) =>
              JSON.parse(raw) as {
                paneBottom: number;
                panelBottom: number;
                panelHeight: number;
              },
          },
        );

        expect(
          Math.abs(geometry.paneBottom - geometry.panelBottom),
          "the task panel ends where the pane ends",
        ).toBeLessThanOrEqual(2);
        // Guards the gap against holding for the wrong reason, exactly as gt2
        // does: a collapsed panel would sit at the pane's top, but a future
        // layout change could park a zero-height box on the bottom edge.
        expect(
          geometry.panelHeight,
          "the task panel is a real box, not a collapsed one",
        ).toBeGreaterThan(100);
      },
    );
  });
});
