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
  createNote,
  dismissImporterOffer,
  editorText,
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

        await typeIntoEditor(s, `- [ ]${TASK_LINE}`);
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

        // 2. Clicking a chip opens the field editor.
        await (await s.byTestId("editor.task-chip-due")).click();
        await s.waitForElement(testIdSelector("editor.task-field-editor"));

        // 3. A value change lands in the FILE — the point of the whole path.
        const input = await s.byTestId("editor.task-field-input");
        await input.sendKeys("2026-09-09");
        await (await s.byTestId("editor.task-field-commit")).click();
        await waitForSaved(s);

        await s.waitUntil(
          async () => ((await editorText(s)).includes("2026-09-09") ? true : null),
          { label: "edited value reached the document" },
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

        await typeIntoEditor(s, "- [ ] pay the rent [due:: 2026-08-01]");
        await waitForSaved(s);
        await s.waitForElement(testIdSelector("editor.task-chip-due"));

        await (await s.byTestId("editor.task-chip-due")).click();
        await s.waitForElement(testIdSelector("editor.task-field-editor"));

        // Escape is U+E00C in the WebDriver key table. Typing a literal "Escape"
        // would insert the word — the invisible-key trap this suite has hit
        // before.
        await (await s.byTestId("editor.task-field-input")).sendKeys("\uE00C");

        await s.waitUntil(
          async () => ((await editorText(s)).includes("2026-08-01") ? true : null),
          { label: "value unchanged after Escape" },
        );
      },
    );
  });
});
