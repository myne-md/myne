// Note-archive lifecycle suite (note-archive / MYND-331, e2e).
//
// Stories:
//   ar1 — context-menu Arşivle → note leaves the tree → Archive panel lists it
//         → Restore returns it to the live tree → re-archive → Delete moves it
//         to Trash (archive ⊥ trash). Mirrors the nc3 soft-trash lifecycle.
//   ar2 — an archived note STAYS in full-text search (archive ≠ soft-trash) and
//         its palette hit carries the archive badge, while a live note does not.
//   ar3 — disabling archiving in Settings → Editor auto-unarchives every archived
//         note (back into the live tree) and hides the Archive footer button
//         (archive-disable, MYND-…).
//
// All driving is real: context menus via the W3C Actions API right-click
// (`contextMenuPick`), the palette via the Control+k chord. No test hooks.

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  openSettings,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Right-click an element and pick a context-menu item by its `data-item-id`. */
async function contextMenuPick(
  session: Session,
  target: { rightClick(): Promise<void> },
  itemId: string,
): Promise<void> {
  await target.rightClick();
  await (
    await session.waitForElement(
      testIdSelector("notes.context-menu-item", { "data-item-id": itemId }),
    )
  ).click();
}

/** Count the NOTES-section hit rows currently rendered in the palette. */
async function noteHitCount(s: Session): Promise<number> {
  const rows = await s.findElements(
    testIdSelector("palette.option", { "data-kind": "note" }),
  );
  return rows.length;
}

/** Count the archive badges currently rendered in the palette. */
async function archiveBadgeCount(s: Session): Promise<number> {
  const badges = await s.findElements(testIdSelector("palette.archived-badge"));
  return badges.length;
}

describeE2E("ar1 archive lifecycle (MYND-331)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("context-menu Arşivle archives; Archive panel restores; Delete → Trash", async () => {
    let password = "";
    await scenario(
      "ar1-archive-restore-delete",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Arşiv Adayı");

        // Archive via the row's real context menu → it leaves the live tree.
        await contextMenuPick(s, await s.byTestId("notes.row"), "archive");
        await s.waitForGone(testIdSelector("notes.row"));

        // Restore from the Archive panel → the row re-enters the live tree.
        await (await s.byTestId("notes.archive-open")).click();
        await s.byTestId("archive.panel");
        await (await s.byTestId("archive.restore")).click();
        await s.waitForGone(testIdSelector("archive.restore"));
        await (await s.byTestId("archive.close")).click();
        await s.byTestId("notes.row");

        // Re-archive, then Delete from the Archive panel → moves to Trash
        // (archive ⊥ trash; permanent purge stays a Trash-panel step).
        await contextMenuPick(s, await s.byTestId("notes.row"), "archive");
        await s.waitForGone(testIdSelector("notes.row"));
        await (await s.byTestId("notes.archive-open")).click();
        await (await s.byTestId("archive.delete")).click();
        await s.waitForGone(testIdSelector("archive.delete"));
        await (await s.byTestId("archive.close")).click();

        // The note now lives in the Trash, not the Archive.
        await (await s.byTestId("notes.trash-open")).click();
        await s.byTestId("trash.restore");
        await (await s.byTestId("trash.close")).click();
      },
    );
  });
});

describeE2E("ar2 archived note stays searchable with a badge (MYND-331)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("an archived hit appears in search and carries the archive badge; a live hit does not", async () => {
    // Shared query both bodies match; the leading space gives a clean word
    // boundary after typeIntoEditor's sacrificial probe char.
    const QUERY = "arsivkanaryabelirteci";
    const LIVE_BODY = ` ${QUERY} canlitail7k`;
    const ARCH_BODY = ` ${QUERY} arsivtail4m`;
    let password = "";
    await scenario(
      "ar2-archived-search-badge",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Live note (control — no badge expected).
        await createNote(s, "Canlı Not");
        await typeIntoEditor(s, LIVE_BODY);
        await waitForSaved(s);

        // Note to archive.
        await createNote(s, "Arşivlik Not");
        await typeIntoEditor(s, ARCH_BODY);
        await waitForSaved(s);

        // Archive the second note via its context menu — the just-created note
        // is the selected row; archive it so it leaves the tree but stays
        // indexed (the Rust BM25 index is archive-blind).
        const selected = await s.waitForElement(
          '[data-testid="notes.row"][aria-current="true"]',
        );
        await contextMenuPick(s, selected, "archive");

        // Open the palette and search the shared query → BOTH notes hit
        // (archive ≠ soft-trash), and exactly ONE carries the archive badge.
        const CONTROL = "\uE009"; // W3C Actions API code point for Control
        await s.send("POST", "/actions", {
          actions: [
            {
              type: "key",
              id: "kbd",
              actions: [
                { type: "keyDown", value: CONTROL },
                { type: "keyDown", value: "k" },
                { type: "keyUp", value: "k" },
                { type: "keyUp", value: CONTROL },
              ],
            },
          ],
        });
        await (await s.byTestId("palette.input")).sendKeys(QUERY);
        await s.waitUntil(
          async () => ((await noteHitCount(s)) === 2 ? true : null),
          { label: "note_search → 2 hits (archived note still searchable)" },
        );
        await s.waitUntil(
          async () => ((await archiveBadgeCount(s)) === 1 ? true : null),
          { label: "exactly one archive badge (archived hit only)" },
        );
        await (await s.byTestId("palette.input")).sendKeys("\uE00C"); // Escape
        await s.waitForGone(testIdSelector("palette.input"));
      },
    );
  });
});

describeE2E("ar3 disabling archiving empties the archive (archive-disable)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("Settings toggle off auto-unarchives the note and hides the Archive button", async () => {
    let password = "";
    await scenario(
      "ar3-disable-archiving",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Ar\u015Fiv Aday\u0131");

        // Archive the note \u2192 it leaves the live tree; the Archive footer button
        // is now present (one archived note).
        await contextMenuPick(s, await s.byTestId("notes.row"), "archive");
        await s.waitForGone(testIdSelector("notes.row"));
        await s.byTestId("notes.archive-open");

        // Disable archiving from Settings \u2192 Editor. The toggle starts "On"
        // (archiving enabled); clicking it empties the Archive first, then
        // persists the disable flag.
        await openSettings(s, "editor");
        await (await s.byTestId("settings.archive-disabled")).click();
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.archive-disabled")).attribute(
              "aria-checked",
            )) === "false"
              ? true
              : null,
          { label: "archiving toggle flips to off" },
        );
        await closeSettings(s);

        // The archived note is back in the live tree (auto-unarchived) and the
        // Archive footer button is gone (archive empty + feature disabled).
        await s.byTestId("notes.row");
        await s.waitForGone(testIdSelector("notes.archive-open"));
      },
    );
  });
});
