// Recurring tasks actually recur, in the real WebView (myne#198).
//
// The unit suite has covered this arithmetic since MYND-615 and stayed green
// while the feature did not exist: the recurrence functions had no production
// caller, so ticking a recurring task flipped the marker and nothing else. Tests
// that call `completeRecurringTask` directly cannot see that, because they ARE
// the caller.
//
// So these scenarios touch nothing but the affordances a user touches — the
// rendered checkbox and the `+` menu — and read the result out of the document.
// That is the whole reason they exist; an assertion here that reached for the
// function instead would reproduce the original blind spot at a higher cost.
//
// **Dates are deliberately far future.** The advance rule steps from the due
// date until it is strictly after today, so a near-term date would make the
// expected result depend on the day the suite runs. `2030-01-15 + every month`
// is one step for the next few years.
//
// `rc3` covers the other half of the same promise (myne#197): a rule that CANNOT
// run must say so. Together they mean a recurring task either works or is
// visibly marked as not working — never confidently rendered and inert.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  editorText,
  editorSourceText,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** A recurring task whose next occurrence is stable for years. */
const RECURRING = " water the plants [due:: 2030-01-15] [repeat:: every month]";

/** How many task checkboxes are rendered — i.e. how many task lines there are. */
async function taskCount(s: Session): Promise<number> {
  return (await s.byTestIdAll("editor.task-checkbox")).length;
}

describeE2E("rc1 ticking a recurring task materializes its next occurrence", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("adds one advanced, unticked line and leaves the completed one dated as it was", async () => {
    let password = "";
    await scenario(
      "rc1-task-recurrence-complete",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Recurring Note");

        await typeIntoEditor(s, `- [ ]${RECURRING}`, { landedText: "water the plants" });
        await waitForSaved(s);

        // One task line, one rendered checkbox.
        await s.waitForElement(testIdSelector("editor.task-checkbox"));
        await s.waitUntil(async () => ((await taskCount(s)) === 1 ? true : null), {
          label: "one task line before the tick",
        });

        // The user's actual gesture: click the checkbox.
        await (await s.byTestId("editor.task-checkbox")).click();

        // Two task lines now — the completed one and its successor.
        await s.waitUntil(async () => ((await taskCount(s)) === 2 ? true : null), {
          label: "next occurrence materialized",
        });

        // SOURCE text, for the reason myne-md/myne#609 gave rc2 one line down:
        // the due chip prints the reader's CHOSEN date format, so both ISO dates
        // live in the document and neither is in the render. rc2 was moved off
        // `editorText` in that change and rc1 was not, which is why this one
        // asserted a string the editor had stopped displaying.
        const text = await editorSourceText(s);
        // The completed line keeps its own date; the new one carries the
        // advanced one. Both present is what proves it was an INSERT rather than
        // a rewrite of the line the user ticked.
        expect(text).toContain("2030-01-15");
        expect(text).toContain("2030-02-15");

        // And it reached the file, not just the screen.
        await waitForSaved(s);
      },
    );
  });
});

describeE2E("rc2 skipping an occurrence advances the line in place", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("moves the date forward, adds no line, and records no completion", async () => {
    let password = "";
    await scenario(
      "rc2-task-recurrence-skip",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Skip Note");

        await typeIntoEditor(s, `- [ ]${RECURRING}`, { landedText: "water the plants" });
        await waitForSaved(s);

        // The caret is still on the task line, so the cursor-gated `+`
        // affordance renders — the entry point the skip row hangs off.
        await s.waitForElement(testIdSelector("editor.task-add-field"));
        await (await s.byTestId("editor.task-add-field")).click();
        await s.waitForElement(testIdSelector("editor.task-field-menu"));

        // The skip row is offered only because this line's rule can actually be
        // advanced — that condition is what this scenario drives through.
        await (await s.byTestId("editor.task-field-menu-skip")).click();
        await s.waitForGone(testIdSelector("editor.task-field-menu"));

        // SOURCE text: the due chip prints the reader's chosen format since
        // myne-md/myne#609, so the advanced ISO date is in the document and not
        // in the render.
        await s.waitUntil(
          async () => ((await editorSourceText(s)).includes("2030-02-15") ? true : null),
          { label: "skipped occurrence advanced the date" },
        );

        const text = await editorSourceText(s);
        // In place: the old date is gone, the rule survives, and no second task
        // line appeared. A skipped occurrence did not happen, so there is also
        // no completion record of it.
        expect(text).not.toContain("2030-01-15");
        expect(text).toContain("every month");
        expect(text).not.toContain("done::");
        expect(await taskCount(s)).toBe(1);

        await waitForSaved(s);
      },
    );
  });
});

describeE2E("rc3 an anchorless repeat rule is shown as unread (myne#197)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("renders no chip, flags the field, and leaves the rule's bytes in place", async () => {
    let password = "";
    await scenario(
      "rc3-task-recurrence-anchorless",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Anchorless Note");

        // A rule the vocabulary reads perfectly, on a line with no date to
        // repeat from. It parses; it can never run.
        await typeIntoEditor(s, "- [ ] shower [repeat:: every day]", {
          landedText: "shower",
        });
        await waitForSaved(s);

        // Flagged rather than chipped — the state the user has to be able to
        // see, since the alternative is finding out months later.
        await s.waitForElement(testIdSelector("editor.task-field-invalid-repeat"));
        expect((await s.byTestIdAll("editor.task-chip-repeat")).length).toBe(0);

        // And the bytes are untouched: a mark decoration, so the raw rule stays
        // visible and the caret can get in to fix it.
        expect(await editorText(s)).toContain("[repeat:: every day]");
      },
    );
  });
});
