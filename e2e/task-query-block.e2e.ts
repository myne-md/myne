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
  ENTER_KEY,
  createNote,
  dismissImporterOffer,
  editorText,
  pressInEditor,
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
        await typeIntoEditor(s, "- [ ] pay the rent [due:: 2026-08-01]", {
          landedText: "pay the rent",
        });
        await waitForSaved(s);

        // A different note carrying the block.
        await createNote(s, "Review");
        await typeIntoEditor(s, BLOCK);
        await waitForSaved(s);
        // The caret is still inside the fence, and a block widget renders only
        // when the caret is OUTSIDE its lines (the live-preview reveal rule) —
        // so the block is still raw source at this point. One Enter moves out.
        await pressInEditor(s, ENTER_KEY);

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
        // The query is `not done`, so a ticked task STOPS MATCHING and the row
        // leaves the block. Waiting for that same row to report `aria-checked`
        // is waiting for something this query can never show — it passed only
        // when the re-render happened to lag the read. The block emptying is
        // the observable effect here; the tick itself is proven below, in the
        // target note's own document.
        await s.waitForElement(testIdSelector("editor.task-query.empty"));

        // 3. Open Bills from the sidebar and see the change in its BYTES —
        //    the assertion that actually proves the cross-note write landed,
        //    rather than that the row redrew.
        // Re-click until the note is actually OPEN: a single `notes.row` click
        // can land before the row is wired and silently not open anything
        // (`reopenNoteAfterReload` carries the same note), which would leave
        // Review on screen and make the assertion below fail for the wrong
        // reason. The block just emptied — `not done` no longer matches the
        // task we ticked — so Review is exactly what stays up otherwise.
        await s.waitUntil(
          async () => {
            // Native DOM click, re-queried each round — the same treatment
            // `reopenNoteAfterReload` gives sidebar rows. A WebDriver click here
            // reports success and leaves the note unopened (observed: Review
            // stays on screen for the full budget while the row is right there).
            await s.execute(
              "var rows = document.querySelectorAll('[data-testid=\"notes.row\"]');" +
                "for (var i = 0; i < rows.length; i++) {" +
                "  if (rows[i].textContent.indexOf('Bills') >= 0) { rows[i].click(); break; }" +
                "} return 1;",
            );
            return (await editorText(s)).includes("pay the rent") ? true : null;
          },
          { label: "Bills is the open note" },
        );
        // The marker is decoration-hidden in live preview (and the `[due:: …]`
        // field renders as a chip), so the document TEXT can never contain the
        // literal `- [x] pay the rent` — asserting on it was asserting on source
        // the user is never shown. The rendered checkbox is the readable proof,
        // and it is built from the reloaded document rather than from the index,
        // so a checked box here means Bills' own bytes carry the tick.
        await s.waitUntil(
          async () => {
            const boxes = await s.byTestIdAll("editor.task-checkbox");
            if (boxes.length === 0) return null;
            const states = await Promise.all(boxes.map((b) => b.attribute("aria-checked")));
            return states.includes("true") ? true : null;
          },
          { label: "the target note's own document carries the tick" },
        );
        // …and the line is the one we ticked, not some other task.
        await s.waitUntil(
          async () => ((await editorText(s)).includes("pay the rent") ? true : null),
          { label: "the ticked line is the rent task" },
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
        await pressInEditor(s, ENTER_KEY); // caret out of the fence — see tq1

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
        await pressInEditor(s, ENTER_KEY); // caret out of the fence — see tq1

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
