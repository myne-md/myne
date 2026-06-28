// Folder notes (index notes) end-to-end suite (MYND-370).
//
// Pins the REWORKED folder-note lifecycle (decisions.md 2026-06-27) against the
// production binary:
//   • the folder note is HIDDEN from the sidebar tree — designating an in-folder
//     note its folder's index makes its row disappear (no separate row, no badge);
//   • DOUBLE-CLICKING the folder opens the (hidden) index note, and double-clicking
//     a folder that has none CREATES + opens one — exactly one per folder;
//   • a folder-target wikilink `[[Folder/]]` still resolves to the hidden index
//     note (resolver projects from `resolverCache`, which keeps folder notes);
//   • undesignate now lives on the FOLDER context menu (`folder.remove-index`) —
//     the note's own row is unreachable once hidden — and re-reveals the row;
//   • the per-note "Set as folder note" action is gated to a folder with no index
//     yet (single-enforcement), so a sibling note can't designate a second.
//
// These are the integrations that can only be checked against the running binary:
// the `setFolderIndex`/`unsetFolderIndex`/`createFolderNote` IPC round-trips, the
// derived folder tree's index wiring + row hiding, the double-click open gesture,
// and the editor's live wikilink resolution over the real note-set.
//
// Note titles / bodies here are in-source scenario constants (accepted SYNC-13
// exception — note content, never a credential; no password or phrase appears in
// any assert below).
//
// Vault-count precondition: 1 per scenario (weak KDF generator fixture — legal:
// unlock reads params from vault.meta).
//
// VERIFICATION STATUS: authored to the harness conventions but NOT yet run on
// this dev platform (macOS; the suite is Linux/tauri-driver only — `pnpm
// test:e2e` self-skips off-platform). Definition of done per e2e/CLAUDE.md is
// "green 3× in the container" (./scripts/e2e-local.sh) and MUST be met before
// merge. Run ISOLATED per the full-suite-contamination note.

import { expect, it } from "vitest";
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

// The CodeMirror document surface (mirrors the private const in support/flows.ts
// — re-declared here so the picker can be driven with raw keystrokes onto the
// SAME element `typeIntoEditor` types into, without exporting harness internals).
const CM_CONTENT = '[data-testid="editor.content"] .cm-content';

/** Right-click an element and pick a context-menu item by its `data-item-id`
 *  (the shared notes/folder menu encoding — `notes.context-menu-item`). */
async function contextMenuPick(
  s: Session,
  target: { rightClick(): Promise<void> },
  itemId: string,
): Promise<void> {
  await target.rightClick();
  await (
    await s.waitForElement(
      testIdSelector("notes.context-menu-item", { "data-item-id": itemId }),
    )
  ).click();
}

/** Open `target`'s context menu, return whether it offers `itemId`, then dismiss
 *  the menu via an outside click (CodeMirror content — far from the sidebar menu,
 *  so the document-level outside-mousedown handler closes it). Waits on an
 *  always-present anchor item first so the check never races menu mount. */
async function contextMenuOffers(
  s: Session,
  target: { rightClick(): Promise<void> },
  itemId: string,
  anchorItemId: string,
): Promise<boolean> {
  await target.rightClick();
  await s.waitForElement(
    testIdSelector("notes.context-menu-item", { "data-item-id": anchorItemId }),
  );
  const hits = await s.findElements(
    testIdSelector("notes.context-menu-item", { "data-item-id": itemId }),
  );
  await (await s.waitForElement(CM_CONTENT)).click(); // outside click → dismiss
  await s.waitForGone(
    testIdSelector("notes.context-menu-item", { "data-item-id": anchorItemId }),
  );
  return hits.length > 0;
}

/** Create a folder via the sidebar "New folder" CTA + its inline input (the
 *  `nc4`/`ms1` flow — the input commits on blur/Enter as `notes.folder-row`
 *  materializes). Lowercase-only name: WebKitWebDriver's Send Keys drops the
 *  shift modifier, so an uppercase char would arrive lowercased — name the
 *  folder a value the driver types faithfully (a driver limitation, not a
 *  product one). */
async function createFolder(s: Session, name: string): Promise<void> {
  await (await s.byTestId("notes.new-folder")).click();
  // `` is the W3C Enter code point — it commits the inline new-folder
  // input. Without it the input never materializes `notes.folder-row` and the
  // next line times out (the nc4 site in notes.e2e.ts carries the same key).
  await (await s.byTestId("notes.new-folder-input")).sendKeys(`${name}`);
  await s.byTestId("notes.folder-row");
}

/** Create a note INSIDE `folder` via its "New note here" context item and commit
 *  `title` through the inline-rename input (the `nc4` pattern). The note's
 *  `folder:` is the folder's path, so it counts toward that folder's index. */
async function createNoteInFolder(
  s: Session,
  folder: { rightClick(): Promise<void> },
  title: string,
): Promise<void> {
  await contextMenuPick(s, folder, "new-note");
  // Trailing `` (W3C Enter) commits the inline rename; without it the
  // rename input never closes and `waitForGone` below times out. Mirrors the
  // canonical `flows.ts::createNote`, which carries the same commit key.
  await (await s.byTestId("notes.rename-input")).sendKeys(`${title}`);
  await s.waitForGone(testIdSelector("notes.rename-input"));
}

/** Read the `data-note-id` of the currently-selected sidebar row — the row
 *  `createNote`/`createNoteInFolder` just left selected, or the row a navigation
 *  landed on (`aria-selected="true"` + `data-note-id`, the byTestId-only handle;
 *  the random-note suite's idiom). */
async function selectedNoteId(s: Session): Promise<string> {
  // Read the OPEN note from the active editor tab, not the sidebar row: a note
  // filed into a folder lives under a collapsible folder row that may be folded
  // shut (hiding its row), but the just-created/opened note is always the active
  // editor tab. The tab carries `data-tab-id="note:<id>"` (Saved Views #4).
  const tab = await s.waitForElement('[data-testid="editor.tab"][data-active="true"]');
  const raw = (await tab.attribute("data-tab-id")) ?? "";
  if (!raw.startsWith("note:")) {
    throw new Error(`active editor tab is not a note tab: "${raw}"`);
  }
  return raw.slice("note:".length);
}

describeE2E("fn1 folder index: designate → hidden → double-click open → link-resolve → undesignate (MYND-370)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("hides the designated index note, opens it by double-clicking the folder, blocks a second, resolves [[Folder/]], then undesignates from the folder menu", async () => {
    // Unique tail tokens pin WHICH note the editor navigated to (random-note's
    // idiom). Leading space gives the inline content a clean word boundary after
    // typeIntoEditor's sacrificial probe char.
    const INDEX_BODY = " indextailx9k2vd";
    const OTHER_BODY = " othertailm7w5qp";
    // Folder name == index-note title: the chip's broken-styling key folds the
    // wikilink's last path segment ("projects"), so `[[projects/]]` reads as
    // RESOLVED (non-broken) exactly when the folder's index note is present.
    const FOLDER = "projects";
    let password = "";
    await scenario(
      "fn1-folder-notes",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // ── A folder + two notes inside it. ──
        await createFolder(s, FOLDER);
        await createNoteInFolder(s, await s.byTestId("notes.folder-row"), FOLDER);
        await typeIntoEditor(s, INDEX_BODY);
        await waitForSaved(s);
        const indexNoteId = await selectedNoteId(s);

        await createNoteInFolder(s, await s.byTestId("notes.folder-row"), "scratch");
        await typeIntoEditor(s, OTHER_BODY);
        await waitForSaved(s);
        const otherNoteId = await selectedNoteId(s);
        expect(indexNoteId).not.toBe(otherNoteId);

        // Ensure the folder is expanded so the notes' sidebar rows are
        // addressable for the designate/undesignate operations below (a single
        // click on the folder row toggles its disclosure — FolderRow.onToggle).
        const folderRow = await s.byTestId("notes.folder-row");
        if ((await folderRow.attribute("aria-expanded")) === "false") {
          await folderRow.click();
        }

        // ── Designate the first note as the folder's index via its row menu. ──
        await contextMenuPick(
          s,
          await s.waitForElement(testIdSelector("notes.row", { "data-note-id": indexNoteId })),
          "note.set-index",
        );
        // The index note is now HIDDEN: its sidebar row disappears, and no badge
        // is rendered anywhere (the old visible-pinned-badge behaviour is gone).
        await s.waitForGone(testIdSelector("notes.row", { "data-note-id": indexNoteId }));
        expect((await s.byTestIdAll("notes.row-folder-index-badge")).length).toBe(0);
        // The sibling note stays a visible row.
        await s.waitForElement(testIdSelector("notes.row", { "data-note-id": otherNoteId }));

        // ── Single-enforcement: the sibling can no longer be made a 2nd index. ──
        expect(
          await contextMenuOffers(
            s,
            await s.waitForElement(testIdSelector("notes.row", { "data-note-id": otherNoteId })),
            "note.set-index",
            "color", // always present in a note row menu
          ),
        ).toBe(false);

        // ── Double-clicking the folder OPENS the hidden index note. ──
        // (We're on the sibling/OTHER_BODY; the open gesture must navigate.)
        await (await s.byTestId("notes.folder-row")).doubleClick();
        await s.waitUntil(
          async () => ((await editorText(s)).includes("indextailx9k2vd") ? true : null),
          { label: "double-click opened the index note" },
        );
        expect((await editorText(s)).includes("othertailm7w5qp")).toBe(false);

        // ── A folder-target wikilink resolves (chip NOT broken) even though the
        // index note is no longer a visible sidebar row. ──
        await typeIntoEditor(s, " "); // settle the cursor + prove the key pipeline
        const content = await s.waitForElement(CM_CONTENT);
        await content.sendKeys(`[[${FOLDER}`);
        await (
          await s.waitForElement(testIdSelector("picker.folder-row"), { timeoutMs: 10_000 })
        ).click();
        // The chip lifts to raw `[[…]]` text while the caret is on its line
        // (cursor-line reveal — chip-widget.ts `isWikilinkRevealed`). Move the
        // caret off the link's line with a newline so the link re-renders as a
        // chip. U+E007 is the W3C Enter code point (never a literal newline; the
        // invisible-key hazard — built via fromCharCode so it survives editing).
        await content.sendKeys(String.fromCharCode(0xe007));
        await s.waitForElement(".cm-wikilink-chip");
        expect((await s.findElements(".cm-wikilink-chip-broken")).length).toBe(0);

        // ── Undesignate from the FOLDER menu; the note re-appears as a row. ──
        await contextMenuPick(s, await s.byTestId("notes.folder-row"), "folder.remove-index");
        await s.waitForElement(testIdSelector("notes.row", { "data-note-id": indexNoteId }));
      },
    );
  });
});

describeE2E("fn2 folder index: double-click a folder with none creates exactly one, hidden, reopened on the next double-click (MYND-370)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("creates the folder note on first double-click, keeps it off the sidebar, and reopens the same note (never a second) on the next", async () => {
    const MARKER = " folderidxmkr8t3z";
    const FOLDER = "ideas";
    let password = "";
    await scenario(
      "fn2-folder-notes",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // An empty (deliberate) folder with no index note.
        await createFolder(s, FOLDER);

        // ── First double-click CREATES + opens the folder note. ──
        await (await s.byTestId("notes.folder-row")).doubleClick();
        await typeIntoEditor(s, MARKER);
        await waitForSaved(s);
        // The folder note is NOT a sidebar row: zero visible note rows exist
        // (the folder's only note is its hidden index note).
        expect((await s.byTestIdAll("notes.row")).length).toBe(0);
        // The folder now exposes the OPEN affordance (it has an index note).
        await s.waitForElement(
          testIdSelector("notes.folder-index-affordance", { "data-folder-path": `${FOLDER}/` }),
        );

        // ── Navigate away (a loose root note), so reopening must re-navigate. ──
        await createNote(s, "loose");
        await typeIntoEditor(s, " looseonlyzzq4n7");
        await waitForSaved(s);

        // ── Second double-click REOPENS the same note (MARKER present) — proof it
        // did not create a second folder note. The loose note stays the only
        // visible row (folder note still hidden → exactly one per folder). ──
        await (await s.byTestId("notes.folder-row")).doubleClick();
        await s.waitUntil(
          async () => ((await editorText(s)).includes("folderidxmkr8t3z") ? true : null),
          { label: "double-click reopened the existing folder note" },
        );
        expect((await editorText(s)).includes("looseonlyzzq4n7")).toBe(false);
        expect((await s.byTestIdAll("notes.row")).length).toBe(1);
      },
    );
  });
});
