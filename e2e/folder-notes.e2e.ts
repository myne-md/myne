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
// VERIFICATION STATUS: fn1/fn2/fn3 verified green 3x consecutive in the
// container on 2026-10-15 with `MYNE_E2E_RETRIES=0` and
// `./scripts/e2e-buildrun.sh folder-notes folder-notes folder-notes` (Docker on
// macOS; each run ~19 s). That run includes the two read-only managed-row
// assertions fn1 gained for myne-md/myne#872, which the earlier 2026-09-05
// verification (myne-md/myne#661) predates. The suite is Linux/tauri-driver
// only, so `pnpm test:e2e` self-skips on a bare macOS host; run ISOLATED per the
// full-suite-contamination note.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  nameNewNote,
  createNote,
  dismissImporterOffer,
  editorText,
  selectedNoteId,
  setFolderNotesEnabled,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
  contextMenuPick,
  createFolder,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

// The CodeMirror document surface (mirrors the private const in support/flows.ts
// — re-declared here so the picker can be driven with raw keystrokes onto the
// SAME element `typeIntoEditor` types into, without exporting harness internals).
const CM_CONTENT = testIdSelector("editor.content") + " .cm-content";


/** Robust "does `targetSelector`'s context menu offer `itemId`?" that RE-FINDS
 *  the target by selector on every attempt. A Settings toggle (fn3) re-renders
 *  the sidebar, which can collapse the folder or replace the row handle mid-poll,
 *  so a captured handle goes stale; re-finding inside the retry survives both.
 *  Waits on the always-present `anchorItemId` (short timeout) to confirm the menu
 *  mounted before reading `itemId`, then dismisses via an outside click. */
async function menuOffers(
  s: Session,
  targetSelector: string,
  itemId: string,
  anchorItemId: string,
): Promise<boolean> {
  const anchor = testIdSelector("notes.context-menu-item", {
    "data-item-id": anchorItemId,
  });
  const wanted = testIdSelector("notes.context-menu-item", {
    "data-item-id": itemId,
  });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      // Short per-attempt waits: a transient miss (row absent mid re-render, a
      // right-click that did not land) must retry fast, never burn the default
      // 45s budget, or a handful of misses would blow the 180s test timeout.
      await (await s.waitForElement(targetSelector, { timeoutMs: 6000 })).rightClick();
      await s.waitForElement(anchor, { timeoutMs: 4000 }); // menu mounted
      const hits = await s.findElements(wanted);
      await (await s.waitForElement(CM_CONTENT)).click(); // outside click → dismiss
      await s.waitForGone(anchor);
      return hits.length > 0;
    } catch (e) {
      lastErr = e;
      // Dismiss any half-open menu, then retry with a freshly-found handle.
      try {
        await (await s.waitForElement(CM_CONTENT)).click();
      } catch {
        /* nothing to dismiss */
      }
    }
  }
  throw lastErr;
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
  await nameNewNote(s, title);
}

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
        // Folder notes ship OFF by default (myne-md/myne#661); this suite drives
        // the folder-index entry points, so enable the feature first.
        await setFolderNotesEnabled(s, true);

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

describeE2E("fn3 folder-notes off-switch: default off hides the entry points; enabling reveals them (myne-md/myne#661)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("offers no folder-index create/set-index actions until the Files setting is turned on", async () => {
    const FOLDER = "notebook";
    let password = "";
    await scenario(
      "fn3-folder-notes-off-switch",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // A folder with one ordinary note inside it. The feature is OFF by
        // default, so nothing here is a folder note yet.
        await createFolder(s, FOLDER);
        await createNoteInFolder(s, await s.byTestId("notes.folder-row"), "page");
        const noteId = await selectedNoteId(s);

        // Expand the folder so the note's row is addressable.
        const folderRow = await s.byTestId("notes.folder-row");
        if ((await folderRow.attribute("aria-expanded")) === "false") {
          await folderRow.click();
        }

        const noteRowSel = testIdSelector("notes.row", { "data-note-id": noteId });
        const folderRowSel = testIdSelector("notes.folder-row");

        // ── Feature OFF (the default): neither entry point is offered. ──
        // `color` / `new-note` are the always-present anchor items of the note /
        // folder menus.
        expect(await menuOffers(s, noteRowSel, "note.set-index", "color")).toBe(false);
        expect(
          await menuOffers(s, folderRowSel, "folder.create-index", "new-note"),
        ).toBe(false);

        // ── Turn the feature ON via Settings → Files. ──
        await setFolderNotesEnabled(s, true);

        // ── The entry point now appears (no reload needed; the prefs-nonce bump
        // reaches the sidebar's own usePrefs). `menuOffers` re-finds the folder
        // row per attempt, so the Settings-toggle re-render cannot stale it. The
        // folder menu is checked here (its row is stable across the re-render);
        // the note "Set as folder note" ON path is covered by fn1, which enables
        // the feature and designates a note through it. ──
        expect(
          await menuOffers(s, folderRowSel, "folder.create-index", "new-note"),
        ).toBe(true);
      },
    );
  });
});
