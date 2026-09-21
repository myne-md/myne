// Empty-folder persistence (myne-md/myne#613).
//
// The reported defect: a folder holding four notes, all four deleted, and the
// folder is gone. Folders are virtual (`protocol.md` §9.5.2 / `markdown-dialect.md`
// §3.6.2), derived per render from each note's `folder:` frontmatter unioned
// with the `deliberate_folders` prefs set. A folder that no note proves and that
// nothing recorded therefore stops existing, silently, with no undo.
//
// This suite pins the three halves of the fix against the running binary, each an
// integration no unit test can reach: at-fill registration (a folder is recorded
// the first time a note lands in it), the once-per-unlock back-fill for a vault
// that predates the rule, and the one thing that must still remove a folder, an
// explicit delete.
//
// The three are separate scenarios on purpose. The first review of this file
// found the header claiming at-fill while neither scenario reached an at-fill
// site: ef1 and ef2 seed through the create IPC, which is past both of them.
//
//   ef1: a folder proved ONLY by a note's frontmatter is registered on the next
//         unlock, so trashing its last note LEAVES THE FOLDER STANDING. Under
//         the pre-#613 code the row vanished with the note.
//   ef2: the other direction, which is what stops ef1 from passing for a
//         version that simply never removes anything: an explicit folder delete
//         still removes it, and it stays gone across a re-unlock.
//   ef3: the at-fill half, through the DAILY NOTE. Its folder comes from the
//         `daily_folder` pref and defaults to `Daily/`, which a fresh vault does
//         not have, so the folder comes into existence solely because the note
//         landed in it. Trashing that note in the SAME session, with no lock in
//         between, must leave the folder standing.
//
//         The daily note is not an arbitrary choice and the first version of
//         this scenario is why. It created the folder with "New folder" and then
//         put a note in it, which pins nothing: that command has written
//         `deliberate_folders` since MYND-144, so the at-fill write was a no-op
//         on an already-registered folder and the assertion passed against a
//         pre-#613 build. Isolating at-fill needs a folder that BOTH nothing
//         else registered AND the unlock back-fill never saw, and on the desktop
//         UI the daily note is the only route that satisfies both: every other
//         way of filing a note into a folder takes the folder from somewhere
//         that already registered it, and every folder present at unlock is
//         back-filled.
//
// **The folder is reached through a non-"New folder" route on purpose.** The
// sidebar's "New folder" command always wrote `deliberate_folders`, so a
// scenario built on it passes against the broken code too. The route here is a
// note carrying `folder:` in its own frontmatter, seeded through the production
// `note_create` IPC (the `vault-export.e2e.ts` idiom) rather than a test hook:
// that is exactly the state an import, the browser clipper, the CLI, or a sync
// pull from a peer whose prefs have not landed yet produces.
//
// Note titles / bodies here are in-source scenario constants (accepted SYNC-13
// exception: note content, never a credential; no password or phrase appears in
// any assert below).
//
// Vault-count precondition: 1 per scenario (weak KDF generator fixture; legal,
// unlock reads params from vault.meta).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickUntilTrue,
  dismissImporterOffer,
  lockAndReunlock,
  pageSeatInvoke,
  runPaletteAction,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const IPC_TIMEOUT = 30_000;

const FOLDER = "Arastirma";
const NOTE_TITLE = "Klasor Notu";
const NOTE_PLAINTEXT = `---
title: ${NOTE_TITLE}
folder: ${FOLDER}/
---

A note filed into a folder nothing ever registered.
`;

const ROOT_NOTE_TITLE = "Kok Not";
const ROOT_NOTE_PLAINTEXT = `---
title: ${ROOT_NOTE_TITLE}
---

A note at the vault root, which no folder delete can touch.
`;

/** Right-click an element and pick a context-menu item by its `data-item-id`
 *  (the shared notes/folder menu encoding). */
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

/** Create a note through the production create IPC, carrying its own folder
 *  frontmatter, and return its id. NOT a test hook: `plugin:notes|note_create`
 *  is the same command the editor's "+ New Note" calls, and the plaintext is
 *  what an import or the CLI would write. The `vault-export.e2e.ts` seeding
 *  idiom. */
async function seedNote(s: Session, plaintext: string): Promise<string> {
  const created = await pageSeatInvoke(
    s,
    "plugin:notes|note_create",
    { plaintext },
    IPC_TIMEOUT,
  );
  expect(created.err, "note_create should succeed").toBeUndefined();
  return created.ok as string;
}

/** The sidebar row for one note, addressed by id rather than by title: the row
 *  carries `data-note-id`, and a title selector would be a second thing that can
 *  drift. */
function noteRow(noteId: string): string {
  return testIdSelector("notes.row", { "data-note-id": noteId });
}

/** The folder row for `FOLDER`, waited for by its canonical path attribute so a
 *  second folder in the tree could never satisfy it. */
function folderRow(): string {
  return testIdSelector("notes.folder-row", { "data-folder-path": `${FOLDER}/` });
}

/** The `Daily/` folder row. Its own constant rather than a `folderRow` argument
 *  because it is not this suite's scenario folder: it is the DEFAULT the
 *  `daily_folder` pref carries, and ef3 turns on that folder not existing until
 *  a note lands in it. */
const DAILY_ROW = testIdSelector("notes.folder-row", { "data-folder-path": "Daily/" });

/** The stored `deliberate_folders`, read through the production IPC.
 *
 *  ef3 asserts the REGISTRATION rather than only the surviving row, because a
 *  row also appears from the note's own frontmatter, which is the pre-fix
 *  behaviour. Reading the set is what tells the two apart. */
async function readDeliberate(s: Session): Promise<string[]> {
  const res = await pageSeatInvoke(s, "plugin:prefs|prefs_read", {}, IPC_TIMEOUT);
  if (res.err !== undefined) {
    throw new Error(`prefs_read rejected: ${JSON.stringify(res.err)}`);
  }
  const view = res.ok as { deliberate_folders?: string[] } | null;
  return view?.deliberate_folders ?? [];
}

describeE2E("ef1 an emptied folder stays (myne-md/myne#613)", () => {
  it("registers a folder proved only by frontmatter, then keeps it when its last note is trashed", async () => {
    let password = "";
    await scenario(
      "ef1-emptied-folder-stays",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // A folder that exists ONLY because a note's frontmatter names it.
        // Nothing has written `deliberate_folders`.
        const noteId = await seedNote(s, NOTE_PLAINTEXT);

        // Re-unlock: the sidebar boots over the new note, the folder row
        // materializes, and the once-per-unlock back-fill registers it. Doing it
        // this way rather than by refreshing in place is deliberate: the
        // back-fill is bound to the boot effect, so a scenario that never locks
        // would pass without ever running the code it is here to test.
        // No `dismissImporterOffer` after this: `lockAndReunlock` already calls
        // `dismissImporterOfferIfPresent`, and the HARD variant would time out,
        // because the offer is a fresh-vault first-editor overlay that does not
        // re-appear on a populated vault.
        await lockAndReunlock(s, password);
        await s.waitForElement(folderRow());

        // Folders are CLOSED unless opened (`src/AGENTS.md`), so the note's row
        // does not exist in the DOM until its folder is expanded. A single click
        // on a non-empty folder row toggles it.
        //
        // `clickUntilTrue` rather than a bare click, and rather than
        // `clickUntilVisible`, which takes bare testids and cannot express an
        // attribute-scoped selector. A click that misses would otherwise leave
        // the wait below burning its whole budget on a row that is never coming,
        // which is the permanent-state family `e2e/AGENTS.md` records. Its 2 s
        // per-attempt window is what keeps a TOGGLE from oscillating.
        await clickUntilTrue(s, folderRow(), {
          done: async () => (await s.findElements(noteRow(noteId))).length > 0,
          label: "folder expands to reveal its note",
          what: "expandFolder",
          trigger: folderRow(),
          outcome: noteRow(noteId),
        });

        // Trash the note. Its folder now has nothing proving it. The row menu's
        // trash item is `delete` (it soft-trashes; the permanent purge lives in
        // the Trash panel).
        await contextMenuPick(s, await s.waitForElement(noteRow(noteId)), "delete");
        await s.waitForGone(noteRow(noteId));

        // THE ASSERTION. Before myne#613 the row went with the note.
        await s.waitForElement(folderRow());

        // And it survives a restart, which is the half the user actually
        // reported: the in-memory set could hold a folder the disk does not.
        await lockAndReunlock(s, password);
        await s.waitForElement(folderRow());
      },
    );
  });
});

describeE2E("ef2 an explicitly deleted folder stays gone (myne-md/myne#613)", () => {
  it("removes the folder on an explicit delete, and it does not come back on the next unlock", async () => {
    let password = "";
    await scenario(
      "ef2-deleted-folder-stays-gone",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Same starting state as ef1, through the same non-"New folder" route,
        // plus a note at the vault ROOT. That one exists only to anchor the
        // negative assertion at the end; it is in no folder, so no folder delete
        // can touch it.
        await seedNote(s, NOTE_PLAINTEXT);
        const rootId = await seedNote(s, ROOT_NOTE_PLAINTEXT);

        await lockAndReunlock(s, password);
        await s.waitForElement(folderRow());

        // Delete the folder itself. It holds a note, so the shared confirm
        // modal gates it and the subtree lands in Trash.
        await contextMenuPick(s, await s.waitForElement(folderRow()), "delete");
        // `NoteList` passes no `confirmTestId`, so this is `DeleteConfirmModal`'s
        // default.
        await (await s.byTestId("delete-confirm.confirm")).click();
        await s.waitForGone(folderRow());

        // THE OTHER DIRECTION, and the reason ef1 is not enough on its own: a
        // version that simply never removes anything from `deliberate_folders`
        // passes ef1 and fails here. The back-fill must not resurrect it either,
        // which it cannot, because the note it would have read is in Trash and
        // a trashed note proves no folder.
        await lockAndReunlock(s, password);
        // The POSITIVE probe first. `findElements` answers immediately, so a
        // bare "zero folder rows" passes against a sidebar that has not rendered
        // its tree yet just as happily as against a correct one. Waiting for the
        // root note's row proves the boot refresh actually landed notes from
        // disk before the folder count below is read.
        await s.waitForElement(noteRow(rootId));
        const rows = await s.findElements(folderRow());
        expect(rows.length, "the deleted folder must not come back").toBe(0);
      },
    );
  });
});

describeE2E("ef3 at-fill: a note landing in a folder registers it (myne-md/myne#613)", () => {
  it("keeps the daily folder after its only note is trashed, with no re-unlock", async () => {
    let password = "";
    await scenario(
      "ef3-at-fill-registers",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Precondition, asserted rather than assumed: `Daily/` does not exist.
        // That is what makes this scenario about at-fill. If the folder were
        // already here the unlock back-fill would have registered it and the
        // closing assertion would pass for the wrong reason, which is exactly
        // how the previous version of this scenario passed.
        expect(
          (await s.findElements(DAILY_ROW)).length,
          "the vault must not already have a Daily/ folder",
        ).toBe(0);
        const before = await readDeliberate(s);
        expect(
          before.some((f) => f.toLowerCase().startsWith("daily/")),
          "nothing may have registered Daily/ before the note lands",
        ).toBe(false);

        // Today's daily note, through the real command-palette action. Its
        // folder comes from the `daily_folder` pref (default `Daily/`) and is
        // handed to `noteCreate`, which is the at-fill chokepoint.
        await runPaletteAction(s, "daily.open-today", "today");
        await s.waitForElement(DAILY_ROW);

        // The registration is the thing under test, so it is read back directly
        // rather than inferred from the row: a row would also appear from the
        // note's own frontmatter, which is the pre-fix behaviour.
        const after = await readDeliberate(s);
        expect(
          after.some((f) => f.toLowerCase().startsWith("daily/")),
          "the daily note's folder must be registered by the create",
        ).toBe(true);

        // Trash it. NO lock and NO unlock: whatever keeps the folder here has to
        // be the registration the create made, because the back-fill runs on the
        // boot path and this session never left it, and it could not have seen
        // this folder anyway.
        await clickUntilTrue(s, DAILY_ROW, {
          done: async () =>
            (await s.findElements(testIdSelector("notes.row"))).length > 0,
          label: "the daily folder expands to reveal its note",
          what: "expandFolder",
          trigger: DAILY_ROW,
          outcome: "[notes.row]",
        });
        const [row] = await s.findElements(testIdSelector("notes.row"));
        if (row === undefined) throw new Error("the daily note has no sidebar row");
        await contextMenuPick(s, row, "delete");
        await s.waitForGone(testIdSelector("notes.row"));

        // THE ASSERTION. Pre-#613 the row went with the note, in this session,
        // with no unlock able to bring it back.
        await s.waitForElement(DAILY_ROW);
      },
    );
  });
});
