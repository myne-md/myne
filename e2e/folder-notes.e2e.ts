// Folder notes (index notes) end-to-end suite (MYND-370).
//
// Pins the folder-note lifecycle against the production binary, exercising the
// real chain a user walks: designate an in-folder note as that folder's index
// via the note context menu → an index badge marks its sidebar row → the folder
// row's affordance opens the index note → a folder-target wikilink `[[Folder/]]`
// resolves to a live (non-broken) chip → removing the designation drops the
// badge. These are the integrations that can only be checked against the running
// binary: the `setFolderIndex` / `unsetFolderIndex` IPC round-trip, the derived
// folder tree's index wiring, and the editor's live wikilink resolution over the
// real note-set.
//
// Note titles / bodies here are in-source scenario constants (accepted SYNC-13
// exception — note content, never a credential; no password or phrase appears in
// any assert below).
//
// Vault-count precondition: 1 (weak KDF generator fixture — legal: unlock reads
// params from vault.meta).
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

/** Create a folder via the sidebar "New folder" CTA + its inline input (the
 *  `nc4`/`ms1` flow — the input commits on blur/Enter as `notes.folder-row`
 *  materializes). Lowercase-only name: WebKitWebDriver's Send Keys drops the
 *  shift modifier, so an uppercase char would arrive lowercased — name the
 *  folder a value the driver types faithfully (a driver limitation, not a
 *  product one). */
async function createFolder(s: Session, name: string): Promise<void> {
  await (await s.byTestId("notes.new-folder")).click();
  // `\uE007` is the W3C Enter code point — it commits the inline new-folder
  // input. Without it the input never materializes `notes.folder-row` and the
  // next line times out (the nc4 site in notes.e2e.ts carries the same key).
  await (await s.byTestId("notes.new-folder-input")).sendKeys(`${name}\uE007`);
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
  // Trailing `` (W3C Enter) commits the inline rename; without it the
  // rename input never closes and `waitForGone` below times out. Mirrors the
  // canonical `flows.ts::createNote`, which carries the same commit key.
  await (await s.byTestId("notes.rename-input")).sendKeys(`${title}\uE007`);
  await s.waitForGone(testIdSelector("notes.rename-input"));
}

/** Resolve the `data-note-id` of the row that visually contains the index badge.
 *  The badge carries no id of its own (it's an inline marker), so this matches
 *  the single `notes.row` whose subtree holds a `notes.row-folder-index-badge`. */
async function resolveBadgedRowId(s: Session): Promise<string> {
  const id = await s.execute<string | null>(
    "var b = document.querySelector('[data-testid=\"notes.row-folder-index-badge\"]');" +
      "if (b === null) return null;" +
      "var row = b.closest('[data-testid=\"notes.row\"]');" +
      "return row === null ? null : row.getAttribute('data-note-id');",
  );
  if (id === null || id === "") {
    throw new Error("no notes.row carried the index badge");
  }
  return id;
}

describeE2E("fn1 folder index note designate / open / link-resolve / undesignate (MYND-370)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("designates a folder index, opens it via the affordance, resolves [[Folder/]], then undesignates", async () => {
    // Unique tail tokens pin WHICH note the editor navigated to (random-note's
    // idiom). Leading space gives the inline content a clean word boundary after
    // typeIntoEditor's sacrificial probe char.
    const INDEX_BODY = " indextailx9k2vd";
    const OTHER_BODY = " othertailm7w5qp";
    // Folder name == index-note title: the chip's broken-styling key folds the
    // wikilink's last path segment ("projects"), so `[[projects/]]` reads as
    // RESOLVED (non-broken) exactly when a note titled "projects" is present.
    // Titling the index note after its folder is both the realistic UX and what
    // makes the chip resolve.
    const FOLDER = "projects";
    let password = "";
    await scenario(
      "fn1-folder-notes",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // ── Step 2: a folder + an index-candidate note inside it. ──
        await createFolder(s, FOLDER);
        await createNoteInFolder(s, await s.byTestId("notes.folder-row"), FOLDER);
        await typeIntoEditor(s, INDEX_BODY);
        await waitForSaved(s);
        const indexNoteId = await selectedNoteId(s);

        // A second note (also in the folder, so the folder stays the same) gives
        // the affordance somewhere to navigate FROM when it opens the index note.
        await createNoteInFolder(s, await s.byTestId("notes.folder-row"), "scratch");
        await typeIntoEditor(s, OTHER_BODY);
        await waitForSaved(s);
        const otherNoteId = await selectedNoteId(s);
        expect(indexNoteId).not.toBe(otherNoteId);

        // ── Step 3: designate the index note via its context menu. ──
        await contextMenuPick(
          s,
          await s.waitForElement(testIdSelector("notes.row", { "data-note-id": indexNoteId })),
          "note.set-index",
        );
        // The index badge appears on the designated note's row.
        await s.byTestId("notes.row-folder-index-badge");
        expect(await resolveBadgedRowId(s)).toBe(indexNoteId);

        // ── Step 4: the folder-row affordance OPENS the index note. ──
        // (We're currently on `scratch`/OTHER_BODY; the affordance must navigate.)
        await (
          await s.waitForElement(
            testIdSelector("notes.folder-index-affordance", { "data-folder-path": `${FOLDER}/` }),
          )
        ).click();
        await s.waitUntil(
          async () => ((await editorText(s)).includes("indextailx9k2vd") ? true : null),
          { label: "affordance opened the index note" },
        );
        expect((await editorText(s)).includes("othertailm7w5qp")).toBe(false);
        expect(await selectedNoteId(s)).toBe(indexNoteId);

        // ── Step 5: a folder-target wikilink resolves (chip NOT broken). ──
        // Author `[[projects/]]` via the picker — deterministic insertion of the
        // canonical trailing-slash form (`emitFolderWikilink`), avoiding the
        // closeBrackets ambiguity of typing the literal `]]`. We're in the index
        // note's editor; establish the keystroke pipeline first (typeIntoEditor's
        // probe), then drive the `[[` picker directly.
        await typeIntoEditor(s, " "); // settle the cursor + prove the key pipeline
        const content = await s.waitForElement(CM_CONTENT);
        await content.sendKeys(`[[${FOLDER}`);
        await (
          await s.waitForElement(
            testIdSelector("picker.folder-row"),
            { timeoutMs: 10_000 },
          )
        ).click();
        // The chip widget replaces the `[[…]]` span. It carries no testid, so it
        // is matched by its CodeMirror class — `.cm-wikilink-chip` present, and the
        // §5.3 broken modifier `.cm-wikilink-chip-broken` ABSENT (resolved link).
        await s.waitForElement(".cm-wikilink-chip");
        expect((await s.findElements(".cm-wikilink-chip-broken")).length).toBe(0);

        // ── Step 6 (GAP — flagged, not scripted): folder rename + inbound
        // `[[Old/]]` → `[[New/]]` rewrite. The product DOES rewrite inbound
        // folder-target links on rename (planFolderRenameBatch / MYND-370), but
        // the folder inline-rename input carries NO data-testid — it is a bare
        // <input> inside notes.folder-row, addressable only by a CSS-descendant /
        // text selector, which the harness forbids (byTestId-only, SYNC-8) and
        // which would be flaky. Driving it is deferred until the folder rename
        // input gains a testid; asserting it here would mean writing the very
        // brittle step the task warned against. The rewrite itself is covered by
        // the renameWikilinks unit tests (src/notes/renameWikilinks.ts). ──

        // ── Step 7: undesignate via the note context menu; badge disappears. ──
        await contextMenuPick(
          s,
          await s.waitForElement(testIdSelector("notes.row", { "data-note-id": indexNoteId })),
          "note.unset-index",
        );
        await s.waitForGone(testIdSelector("notes.row-folder-index-badge"));
      },
    );
  });
});

/** Read the `data-note-id` of the currently-selected sidebar row — the row
 *  `createNote`/`createNoteInFolder` just left selected, or the row a navigation
 *  landed on (`aria-selected="true"` + `data-note-id`, the byTestId-only handle;
 *  the random-note suite's idiom). */
async function selectedNoteId(s: Session): Promise<string> {
  const row = await s.waitForElement('[data-testid="notes.row"][aria-selected="true"]');
  const id = await row.attribute("data-note-id");
  if (id === null || id === "") {
    throw new Error("selected notes.row carried no data-note-id");
  }
  return id;
}
