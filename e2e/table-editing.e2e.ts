// GFM table in-place editing suite (MYND-162, editor-table-editing).
//
// Pins the editable-grid layer on top of MYND-139's read-only render: the
// `/table` slash command inserts a top-level pipe table that renders as an
// EDITABLE `<table>` (data-editable="true"); a cell edited through its
// `<input>` commits canonical single-space source that survives the full AEAD
// round-trip (lock → unlock re-decrypts the MY01 blob); and the add-column
// affordance grows the grid. Production code gained observability testids only
// (table.grid / table.cell / table.cell-input / table.add-column …) — no hooks.
//
// In-source scenario constants are not credentials; SYNC-13 applies to
// passwords/phrases, which never appear in any assert below.
//
// INSERT PATH: the table is created via the `/table` slash command, NOT by
// typing raw pipe markdown. Typed markdown builds line-by-line, so the editable
// widget renders the instant the delimiter row completes and swallows the body
// row — `/table` inserts the whole grid in one dispatch and avoids that. Cells
// are then driven by explicit click + `table.cell-input` (no reliance on the
// post-insert auto-focus timing).
//
// ⚠ PLATFORM: the harness drives the production binary via tauri-driver and is
// Linux-only — this suite is authored to the conventions but MUST be run green
// 3× in the container (`./scripts/e2e-local.sh`) before merge; it has not been
// executed on the authoring machine (macOS). See e2e/AGENTS.md "definition of
// done".

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { createNote, dismissImporterOffer, unlockToEditor, waitForSaved } from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const CM_CONTENT = testIdSelector("editor.content") + " .cm-content";
const BACKSPACE = "\uE003"; // W3C key codepoint
const ENTER = "\uE007"; // W3C key codepoint

/** Selector for the rendered cell at grid `(row, col)` (row 0 = header). */
const cell = (row: number, col: number): string =>
  testIdSelector("table.cell", { "data-row": String(row), "data-col": String(col) });

/** Insert an editable empty 2×2 table via the `/table` slash command, leaving
 *  the rendered grid in the document. Establishes the CM key pipeline first
 *  (a probe char then deleted), so the trigger is not eaten by the focus-settle
 *  drop, and types `/table` on an empty line so the slash menu opens cleanly. */
async function insertTable(session: Session): Promise<void> {
  const content = await session.waitForElement(CM_CONTENT);
  await content.click();
  await session.waitUntil(
    async () => {
      await content.sendKeys("x");
      return (await content.textContent()).includes("x") || null;
    },
    { label: "keystroke pipeline established", timeoutMs: 10_000 },
  );
  await content.sendKeys(BACKSPACE); // drop the probe char → empty line
  await content.sendKeys(`/table${ENTER}`); // slash menu → apply → empty 2×2 grid
  await session.byTestId("table.grid");
}

/** Click a cell open, type a value into its input, and commit with Enter. */
async function editCell(session: Session, row: number, col: number, value: string): Promise<void> {
  await (await session.waitForElement(cell(row, col))).click();
  const input = await session.byTestId("table.cell-input");
  await input.sendKeys(`${value}${ENTER}`); // Enter blurs → commit
}

describeE2E("te1 editable grid survives the AEAD round-trip (MYND-162)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a /table grid renders editable and a cell edit persists through lock → unlock", async () => {
    let password = "";
    await scenario(
      "te1-editable-roundtrip",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Tablo Defteri");

        await insertTable(s);
        // Top-level table → editable.
        expect(await (await s.byTestId("table.grid")).attribute("data-editable")).toBe("true");
        await editCell(s, 0, 0, "Name");
        await waitForSaved(s);

        // Lock (flushes) → unlock → reopen; the edited content survived the
        // MY01 round-trip and still renders in the grid.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);
        await (await s.byTestId("notes.row")).click();

        await s.byTestId("table.grid");
        const headerCell = await s.waitForElement(cell(0, 0));
        await s.waitUntil(
          async () => (await headerCell.textContent()).includes("Name") || null,
          { label: "table content survives the AEAD round-trip" },
        );
      },
    );
  });
});

describeE2E("te2 cell edit commits canonical source (MYND-162)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("editing a cell through its input writes the change back into the grid", async () => {
    let password = "";
    await scenario(
      "te2-cell-edit",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Hücre Notu");
        await insertTable(s);

        await editCell(s, 1, 0, "Grace");
        const bodyCell = await s.waitForElement(cell(1, 0));
        await s.waitUntil(
          async () => (await bodyCell.textContent()).includes("Grace") || null,
          { label: "edited value renders in the cell" },
        );
      },
    );
  });
});

describeE2E("te3 add-column affordance grows the grid (MYND-162)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the add-column affordance appends a column", async () => {
    let password = "";
    await scenario(
      "te3-add-column",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Sütun Notu");
        await insertTable(s);

        const headerCols = testIdSelector("table.cell", { "data-row": "0" });
        expect((await s.findElements(headerCols)).length).toBe(2);
        await (await s.byTestId("table.add-column")).click();
        await s.waitUntil(
          async () => (await s.findElements(headerCols)).length === 3 || null,
          { label: "a third header column appears" },
        );
      },
    );
  });
});
