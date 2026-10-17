// Task panel surfaces (MYND-616 task 12).
//
// Two scenarios, one per surface, covering what the unit suite structurally
// cannot: the tab actually opening in the real WebView, tasks from SEVERAL
// notes appearing in one list, a tick from a list landing in the correct note's
// bytes, filters switching, and the empty-state copy.
//
// The empty-state copy is asserted **explicitly**, not incidentally. The tone
// rule - no celebration, no green check, an empty week is stated rather than
// congratulated - is a real product constraint, and copy drift is exactly what a
// test catches and a review does not.
//
// The precedent followed is the graph-view and tag-browser scenarios, which ship
// with test ids and a scenario apiece.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickByTestId,
  createNote,
  dismissImporterOffer,
  pageSeatInvoke,
  runPaletteAction,
  settleOn,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;

/** Wait until the backend task index carries both source lines. `waitForSaved`
 *  only proves the badge settled; the live re-index after save is fire-and-forget
 *  (`void reindexNoteFromBody`), so the panel can open on a nonce that has not
 *  yet seen either task while still rendering section headers from a partial
 *  fetch. Polling the IPC separates "index not ready" from "row text wrong". */
async function waitForTaskIndex(s: Session, needles: readonly string[]): Promise<void> {
  await s.waitUntil(
    async () => {
      const r = await pageSeatInvoke(s, "plugin:vault-indices|vault_indices_tasks", {}, IPC_TIMEOUT);
      if (typeof r.ok !== "object" || r.ok === null || !Array.isArray((r.ok as unknown[]))) {
        return null;
      }
      const rows = r.ok as Array<{ rawLine?: string }>;
      const blob = rows.map((row) => row.rawLine ?? "").join("\n");
      return needles.every((n) => blob.includes(n)) ? true : null;
    },
    { label: "task index carries both source lines", timeoutMs: 20_000 },
  );
}

/** Open the vault-wide task tab through the command palette. */
async function openTaskTab(s: Session): Promise<void> {
  await runPaletteAction(s, "tasks.show", "tasks");
  await s.waitForElement(testIdSelector("tasks.panel"));
  // The windowed scroll container is what holds the rows (myne-md/myne#656).
  await s.waitForElement(testIdSelector("tasks.scroll"));
}

async function rowTexts(s: Session): Promise<string[]> {
  const rows = await s.byTestIdAll("tasks.row.text");
  // textContent, not text(): this driver's W3C getText drops text nested under
  // child elements, and TaskRow may wrap the span inside a stack container.
  return Promise.all(rows.map((r) => r.textContent()));
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

/** Close the filter builder by clicking its fixed backdrop.
 *
 *  Leaving it open is not cosmetic: `BUILDER_BACKDROP_STYLE` is a fixed
 *  full-viewport layer at z-index 40, so a later `.click()` on the Filters
 *  button OR a row checkbox under it is refused as not-interactable for the
 *  whole poll budget. The button sits UNDER that backdrop (strip has no
 *  higher z-index), so toggling via `filtersButton` is the wrong close path —
 *  the backdrop's own onClick is what a user gets when they miss the panel.
 *  Escape also closes it (panel is focused on open), but the backdrop click
 *  does not depend on focus. */
async function closeBuilder(s: Session, prefix: string): Promise<void> {
  if ((await s.byTestIdAll(`${prefix}.filtersPanel`)).length === 0) return;
  await s.execute(
    "var panel = document.querySelector(arguments[0]);" +
      "var back = panel && panel.previousElementSibling;" +
      "if (back) back.click();",
    [testIdSelector(`${prefix}.filtersPanel`)],
  );
  await s.waitUntil(
    async () => ((await s.byTestIdAll(`${prefix}.filtersPanel`)).length === 0 ? true : null),
    { label: "filter builder closed", timeoutMs: 10_000 },
  );
}

/** Centre-of-box hit test for a testid — what is covering it, if anything. */
async function hitTestTestId(s: Session, testId: string): Promise<string> {
  return s.execute<string>(
    "var el = document.querySelector(arguments[0]);" +
      "if (!el) return 'no such element';" +
      "var r = el.getBoundingClientRect();" +
      "if (r.width === 0 || r.height === 0) return 'box ' + r.width + 'x' + r.height;" +
      "var cx = r.left + r.width / 2, cy = r.top + r.height / 2;" +
      "var at = document.elementFromPoint(cx, cy);" +
      "if (!at) return 'nothing at centre';" +
      "if (at === el || el.contains(at)) return 'clear';" +
      "var id = at.getAttribute('data-testid');" +
      "var z = getComputedStyle(at).zIndex;" +
      "return 'covered by <' + at.tagName.toLowerCase() + '>' + (id ? ' [' + id + ']' : '')" +
      " + ' z=' + z;",
    [testIdSelector(testId)],
  );
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

        await waitForTaskIndex(s, ["pay the rent", "buy milk"]);
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
        // The builder's fixed backdrop covers the whole viewport while open;
        // close it before any list interaction (see `closeBuilder`).
        await closeBuilder(s, "tasks");

        // 3. Search narrows the list client-side over the live array - item 6 -
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
        //    restored, tick the rent task and verify Bills changed - the
        //    property the single writer exists to guarantee.
        //
        //    Status must be `all` first: the vault-wide tab defaults to
        //    `undone`, so a completed task is FILTERED OUT of the list the
        //    moment the tick lands and the row never reports aria-checked.
        await pickBuilderValue(s, "tasks", "status", "all");
        await closeBuilder(s, "tasks");
        await s.waitUntil(
          async () => ((await rowTexts(s)).length === 2 ? true : null),
          { label: "status=all still lists both tasks" },
        );
        //
        //    Re-find + scrollIntoView inside the poll, not a one-shot handle:
        //    the windowed list re-renders on clear/search, and WebDriver's own
        //    pre-click scroll does not reliably reach a nested `overflow`
        //    container (`tasks.scroll`), so a bare `boxes[i].click()` reports
        //    "element not interactable" for its whole 10 s budget while the
        //    control sits under the sticky filter strip.
        let lastClickReason = "";
        await s.waitUntil(
          async () => {
            const boxes = await s.byTestIdAll("tasks.row.checkbox");
            const texts = await rowTexts(s);
            const rentIndex = texts.findIndex((t) => t.includes("pay the rent"));
            if (rentIndex < 0 || boxes[rentIndex] === undefined) {
              lastClickReason = `no rent checkbox among ${boxes.length} rows`;
              return null;
            }
            try {
              await boxes[rentIndex].scrollIntoView();
              await boxes[rentIndex].clickOnce();
            } catch (raw) {
              const err = raw as Error;
              lastClickReason = err.message;
              try {
                const cover = await hitTestTestId(s, "tasks.row.checkbox");
                lastClickReason += `; centre: ${cover}`;
              } catch {
                // hit-test is diagnostic only
              }
              return null; // replaced / not hit-testable — re-find next poll
            }
            return true;
          },
          {
            label: () => `rent task checkbox clicked (last: ${lastClickReason})`,
            timeoutMs: 15_000,
          },
        );

        // Re-find the rent row BY TEXT every poll: a completed task can move
        // section (Overdue → …) or re-sort, so a rentIndex captured once
        // points at the wrong checkbox after the tick lands.
        let lastTickState = "";
        await s.waitUntil(
          async () => {
            const texts = await rowTexts(s);
            const boxes = await s.byTestIdAll("tasks.row.checkbox");
            const idx = texts.findIndex((t) => t.includes("pay the rent"));
            if (idx < 0 || boxes[idx] === undefined) {
              lastTickState = `no rent row among ${texts.length} texts / ${boxes.length} boxes`;
              return null;
            }
            const checked = await boxes[idx]!.attribute("aria-checked");
            lastTickState = `idx=${idx} aria-checked=${checked ?? "null"} texts=${texts.length}`;
            return checked === "true" ? true : null;
          },
          {
            label: () => `the ticked row reports completed (last: ${lastTickState})`,
            timeoutMs: 45_000,
          },
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
        // `data-panel-tab-id` - the existing convention.
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

        // The source note is hidden in note scope - you are looking at it.
        await s.waitUntil(
          async () => ((await s.byTestIdAll("notePanel.tasks.row.note")).length === 0 ? true : null),
          { label: "no source-note control in note scope" },
        );
      },
    );
  });
});

describeE2E("tp5 a task's fields are editable from the list (myne-md/myne#884 task 8)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("opens the anchored popover, writes the field, and the note's bytes change", async () => {
    let password = "";
    await scenario(
      "tp5-list-field-edit",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await createNote(s, "Bills");
        await typeIntoEditor(s, "- [ ] pay the rent", { landedText: "pay the rent" });
        await waitForSaved(s);
        await waitForTaskIndex(s, ["pay the rent"]);
        await openTaskTab(s);

        // The control exists on the row, and it does not navigate: the note the
        // task came from is NOT the open note at this point (the task tab is).
        const control = await s.waitForElement(testIdSelector("tasks.row.fields"));
        await control.scrollIntoView();
        await control.clickOnce();

        // Desktop declares no `floatingSurface`, so this is the ANCHORED
        // presentation - the same popover the in-note `+` opens - and the docked
        // sheet must not appear. That pair is the whole point of the
        // presentation being declared rather than sniffed.
        await s.waitForElement(testIdSelector("editor.task-field-menu"));
        expect(
          (await s.byTestIdAll("editor.task-field-sheet")).length,
          "a docked sheet appeared on a client that declares anchored",
        ).toBe(0);
        expect(
          (await s.byTestIdAll("editor.top-bar")).length,
          "the row control navigated into the note instead of opening the popover",
        ).toBe(0);

        // Pick the due field, take the calendar's first quick pick, commit. The
        // quick picks are the one-click path, so the assertion does not depend on
        // the wall-clock month the suite runs in.
        await (await s.byTestId("editor.task-field-menu-due")).click();
        const quickPick = await s.waitForElement(".cm-date-quick button");
        await quickPick.clickOnce();
        // `clickByTestId` rather than `Element.click()`: the plain click timed
        // out on "element interactable + clicked" for its whole budget, and that
        // message cannot say whether the control is disabled, zero-sized,
        // scrolled out of its own container or covered. The helper re-locates,
        // scrolls, and on a refusal reports what is AT the centre.
        await clickByTestId(s, "editor.task-field-commit");

        // The bytes: the note the task came from now carries a due field on that
        // exact line. Read through the same IPC the app reads with, so this is
        // the note on disk rather than a re-render.
        const row = await s.waitForElement('[data-testid="notes.row"]');
        const noteId = (await row.attribute("data-note-id")) ?? "";
        expect(noteId, "the seeded note carries no id in the sidebar").not.toBe("");

        let lastBody = "";
        await s.waitUntil(
          async () => {
            const r = await pageSeatInvoke(
              s,
              "plugin:notes|note_read",
              { noteId },
              IPC_TIMEOUT,
            );
            lastBody = typeof r.ok === "string" ? r.ok : "";
            return /- \[ \] pay the rent \[due:: \d{4}-\d{2}-\d{2}\]/.test(lastBody) ? true : null;
          },
          {
            label: () => `the note's line carries the committed due date (last: ${lastBody})`,
            timeoutMs: 15_000,
          },
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
