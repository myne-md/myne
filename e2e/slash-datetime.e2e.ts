// Slash date/time inserts (MYND-338, w25-low-batch).
//
// Pins that the `/date` slash command inserts a frozen LOCAL date string
// (YYYY-MM-DD shape) into the live CodeMirror document. The clock is live, so
// the assert matches the SHAPE, never a frozen literal (the value can't be
// pinned without a test hook, which the harness forbids).
//
// Driving the slash menu without a CSS-class/menu-DOM selector (byTestId-only
// rule): type `/date` at a line start — the floating menu opens — then press
// Enter, which the Prec.highest slash keymap's `confirm()` consumes to apply
// the top fuzzy match ("Date"). No menu element is queried.
//
// Note content here is an in-source scenario constant, not a credential
// (SYNC-13 governs passwords/phrases, which never appear in any assert below).

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { createNote, dismissImporterOffer, editorText, unlockToEditor } from "./support/flows";

const ENTER = ""; // W3C Actions API code point for Enter
const CM_CONTENT = '[data-testid="editor.content"] .cm-content';

describeE2E("sd1 /date slash insert (MYND-338)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("typing /date + Enter inserts a YYYY-MM-DD-shaped date", async () => {
    let password = "";
    await scenario(
      "sd1-slash-date",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Tarih Notu");

        const content = await s.waitForElement(CM_CONTENT);
        await content.click();
        // Establish the keystroke pipeline AND land the caret on a fresh line
        // start (a probe char then newline), so the following `/` sits at a line
        // start and the slash menu opens (it suppresses mid-word `/`).
        await s.waitUntil(
          async () => {
            await content.sendKeys("x\n");
            return (await editorText(s)).includes("x") || null;
          },
          { label: "keystroke pipeline established at a line start", timeoutMs: 10_000 },
        );

        // Open the slash menu (`/date`) and confirm the top match with Enter.
        await content.sendKeys(`/date${ENTER}`);

        await s.waitUntil(
          async () => {
            const t = await editorText(s);
            return (/\d{4}-\d{2}-\d{2}/.test(t) && !t.includes("/date")) || null;
          },
          { label: "/date resolved to a YYYY-MM-DD-shaped string" },
        );
      },
    );
  });
});
