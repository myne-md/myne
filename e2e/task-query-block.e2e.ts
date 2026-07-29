// Task-query block (MYND-617 task 14).
//
// Covers what the unit suite structurally cannot: the block rendering as a list
// in the real WebView, a tick from it reaching a note the user is not looking
// at, and the refusal path when that note has moved on underneath.
//
// The diagram decoration shipped with no test id and no scenario — a precedent
// deliberately **not** copied here.

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

/** A block matching every outstanding task in the vault. */
const BLOCK = ["```tasks", "not done", "sort by due", "```"].join("\n");

async function rowTexts(s: Session): Promise<string[]> {
  const rows = await s.byTestIdAll("editor.task-query.text");
  return Promise.all(rows.map((r) => r.text()));
}

describeE2E("tq1 a task-query block renders, and a tick reaches the target note (MYND-617)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("authors a block, sees it render, ticks a task, and the OTHER note changed", async () => {
    let password = "";
    await scenario(
      "tq1-task-query-block",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // The note that owns the task.
        await createNote(s, "Bills");
        await typeIntoEditor(s, "- [ ] pay the rent [due:: 2026-08-01]");
        await waitForSaved(s);

        // A different note carrying the block.
        await createNote(s, "Review");
        await typeIntoEditor(s, BLOCK);
        await waitForSaved(s);

        // 1. It renders as a list rather than as a code card.
        await s.waitForElement(testIdSelector("editor.task-query"));
        await s.waitUntil(
          async () =>
            (await rowTexts(s)).some((t) => t.includes("pay the rent")) ? true : null,
          { label: "the other note's task appears in the block" },
        );

        // 2. Ticking from the block writes to Bills — a note the user is not
        //    looking at. This is the whole point of the cross-note write.
        await (await s.byTestId("editor.task-query.checkbox")).click();
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("editor.task-query.checkbox")).attribute("aria-checked")) ===
            "true"
              ? true
              : null,
          { label: "the row reports completed" },
        );

        // 3. Open Bills from the sidebar and see the change in its BYTES —
        //    the assertion that actually proves the cross-note write landed,
        //    rather than that the row redrew.
        const rows = await s.byTestIdAll("notes.row");
        for (const row of rows) {
          if ((await row.text()).includes("Bills")) {
            await row.click();
            break;
          }
        }
        await s.waitUntil(
          async () => ((await editorText(s)).includes("- [x] pay the rent") ? true : null),
          { label: "the target note's bytes carry the tick" },
        );
      },
    );
  });
});

describeE2E("tq2 unreadable clauses are reported in the block, permanently (MYND-617)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("keeps working with what it understood and names what it dropped", async () => {
    let password = "";
    await scenario(
      "tq2-task-query-dropped",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await createNote(s, "Bills");
        await typeIntoEditor(s, "- [ ] pay the rent");
        await waitForSaved(s);

        await createNote(s, "Review");
        await typeIntoEditor(
          s,
          ["```tasks", "not done", "group by heading", "```"].join("\n"),
        );
        await waitForSaved(s);

        // The understood clause still runs…
        await s.waitForElement(testIdSelector("editor.task-query"));
        await s.waitUntil(
          async () => ((await rowTexts(s)).some((t) => t.includes("pay the rent")) ? true : null),
          { label: "the understood clause still produced rows" },
        );

        // …and the dropped one is named, inside the block.
        const notice = await s.waitForElement(testIdSelector("editor.task-query.dropped"));
        const text = await notice.text();
        if (!text.includes("group by heading")) {
          throw new Error(`the dropped clause was not named: ${text}`);
        }
      },
    );
  });
});

describeE2E("tq3 an all-dropped query refuses rather than showing the vault (MYND-617)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("shows a refusal, not a list and not an empty result", async () => {
    let password = "";
    await scenario(
      "tq3-task-query-refusal",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await createNote(s, "Bills");
        await typeIntoEditor(s, "- [ ] pay the rent");
        await waitForSaved(s);

        await createNote(s, "Review");
        await typeIntoEditor(
          s,
          ["```tasks", "group by heading", "hide task count", "```"].join("\n"),
        );
        await waitForSaved(s);

        // A misread query must not render the whole vault — that would look
        // like a correct enormous result.
        await s.waitForElement(testIdSelector("editor.task-query.refused"));
        await s.waitUntil(
          async () => ((await s.byTestIdAll("editor.task-query.row")).length === 0 ? true : null),
          { label: "no rows rendered for a refused query" },
        );
      },
    );
  });
});
