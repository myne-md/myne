// Notes lifecycle suite (MYND-223, e2e-expansion wave 2).
//
// Pins what happens INSIDE an unlocked vault for the first time: a note
// typed through the real CodeMirror surface survives the full AEAD
// round-trip (lock → unlock re-decrypts the MY01 blob) and a WebView
// reload; the soft-trash lifecycle (context-menu Delete → Trash panel →
// restore / permanent purge, MYND-133); and the MYND-144 rule that
// deleting a non-empty folder soft-trashes its notes instead of losing
// them.
//
// Driving notes: note creation enters inline-rename immediately
// (`createAndStartRename`) — the title is committed with Enter before
// the body is typed. Context menus are real right-clicks via the W3C
// Actions API (`Element.rightClick`). The Lock CTA flushes the autosave
// BEFORE `vault_lock` (Editor.tsx `flushIfDirty`), so nc1 needs no save
// wait; nc2 (reload) has no such guarantee and explicitly waits out the
// γ1 idle-debounce via the save-status badge.
//
// Note plaintext here is an in-source scenario constant (not a
// credential); SYNC-13 applies to passwords/phrases, which never appear
// in any assert below.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { dismissImporterOffer, unlockToEditor } from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const CM_CONTENT = '[data-testid="editor.content"] .cm-content';

/** Create a note via the sidebar CTA and commit `title` through the
 *  inline-rename input (Enter). Leaves the note selected. */
async function createNote(session: Session, title: string): Promise<void> {
  await (await session.byTestId("notes.create")).click();
  const rename = await session.byTestId("notes.rename-input");
  await rename.sendKeys(`${title}`);
  await session.waitForGone(testIdSelector("notes.rename-input"));
}

/** Type into the live CodeMirror document. A plain element click does
 *  NOT focus CM under this driver (activeElement stays put); sendKeys'
 *  implicit focus does, but keys sent during that focus settle drop
 *  silently (observed as a truncated leading edge). So: probe with a
 *  sacrificial character until one actually lands — proof the key
 *  pipeline is live — then send the payload and verify it arrived.
 *  Callers' asserts are `includes(...)`, so stray probe chars are
 *  harmless. */
async function typeIntoEditor(session: Session, text: string): Promise<void> {
  const content = await session.waitForElement(CM_CONTENT);
  await content.click();
  await session.waitUntil(
    async () => {
      await content.sendKeys("q");
      return (await editorText(session)).includes("q") || null;
    },
    { label: "keystroke pipeline established", timeoutMs: 10_000 },
  );
  await content.sendKeys(text);
  await session.waitUntil(async () => (await editorText(session)).includes(text) || null, {
    label: "typed text landed in the document",
  });
}

/** Wait until the autosave badge settles on "Saved" AFTER having seen
 *  the edit register ("Editing…"/"Saving…") — polling for "Saved" alone
 *  could match the pre-edit clean state. */
async function waitForSaved(session: Session): Promise<void> {
  // The post-edit saved state renders "Saved·<rel>" (separator + relative
  // time) — distinguishable from the pre-edit clean state's bare "Saved",
  // so this can't pass before the edit's own save actually landed.
  await session.waitUntil(
    async () =>
      (await (await session.byTestId("editor.save-status")).textContent()).includes("Saved·") ||
      null,
    { label: "autosave settled on Saved·<rel>", timeoutMs: 15_000 },
  );
}

/** Current CodeMirror document text (`textContent()` — the doc lives in
 *  nested .cm-line elements this driver's getText drops). Re-found per
 *  call: CM remounts across relock/reload. */
async function editorText(session: Session): Promise<string> {
  return (await session.waitForElement(CM_CONTENT)).textContent();
}

/** Right-click an element and pick a context-menu item by its
 *  `data-item-id`. */
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

describeE2E("nc1 note content AEAD round-trip (MYND-223)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("typed content survives lock → unlock (Lock CTA flushes before vault_lock)", async () => {
    const MARKER = "kanarya-2026 ilk nota satiri";
    let password = "";
    await scenario(
      "nc1-roundtrip",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await createNote(s, "Deniz Feneri");
        await typeIntoEditor(s, MARKER);

        // No save wait on purpose: the Lock CTA's flush IS the contract
        // under test (an unflushed buffer would lose the marker).
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);

        await (await s.byTestId("notes.row")).click();
        await s.waitUntil(async () => (await editorText(s)).includes(MARKER) || null, {
          label: "marker survives the AEAD round-trip",
        });
      },
    );
  });
});

describeE2E("nc2 reload mid-edit (MYND-223)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("content settled by the autosave survives a WebView reload", async () => {
    const MARKER = "martı-7 reload provası";
    let password = "";
    await scenario(
      "nc2-reload-mid-edit",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await createNote(s, "Reload Defteri");
        await typeIntoEditor(s, MARKER);
        // A reload has NO flush hook — the γ1 settle is load-bearing.
        await waitForSaved(s);

        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
        await (await s.byTestId("notes.row")).click();
        await s.waitUntil(async () => (await editorText(s)).includes(MARKER) || null, {
          label: "marker survives the reload",
        });
      },
    );
  });
});

describeE2E("nc3 soft-trash lifecycle (MYND-223 / MYND-133)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("context-menu Delete soft-trashes; Trash restores; permanent purge empties", async () => {
    let password = "";
    await scenario(
      "nc3-trash-restore-purge",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Çöp Adayı");

        // Soft-trash via the row's real context menu — no confirm modal
        // (reversible action; the undo toast is the affordance).
        await contextMenuPick(s, await s.byTestId("notes.row"), "delete");
        await s.waitForGone(testIdSelector("notes.row"));

        // Restore from the Trash panel.
        await (await s.byTestId("notes.trash-open")).click();
        await s.byTestId("trash.panel");
        await (await s.byTestId("trash.restore")).click();
        await s.waitForGone(testIdSelector("trash.restore"));
        await (await s.byTestId("trash.close")).click();
        await s.byTestId("notes.row");

        // Trash again, then PERMANENT delete — this one confirms.
        await contextMenuPick(s, await s.byTestId("notes.row"), "delete");
        await s.waitForGone(testIdSelector("notes.row"));
        await (await s.byTestId("notes.trash-open")).click();
        await (await s.byTestId("trash.delete")).click();
        await (await s.byTestId("delete-confirm.confirm")).click();
        await s.waitForGone(testIdSelector("trash.delete"));
        await (await s.byTestId("trash.close")).click();
        expect((await s.byTestIdAll("notes.row")).length).toBe(0);
      },
    );
  });
});

describeE2E("nc4 folder delete soft-trashes its notes (MYND-223 / MYND-144)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("deleting a non-empty folder moves its notes to the Trash after a confirm", async () => {
    let password = "";
    await scenario(
      "nc4-folder-soft-trash",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Folder + a note inside it (context-menu "New note here").
        await (await s.byTestId("notes.new-folder")).click();
        await (await s.byTestId("notes.new-folder-input")).sendKeys("Arsiv");
        const folder = await s.byTestId("notes.folder-row");
        await contextMenuPick(s, folder, "new-note");
        await (await s.byTestId("notes.rename-input")).sendKeys("Klasör Notu");
        await s.waitForGone(testIdSelector("notes.rename-input"));
        await s.byTestId("notes.row");

        // Folder delete: non-empty → confirm → subtree soft-trashes.
        await contextMenuPick(s, await s.byTestId("notes.folder-row"), "delete");
        await (await s.byTestId("delete-confirm.confirm")).click();
        await s.waitForGone(testIdSelector("notes.folder-row"));
        await s.waitForGone(testIdSelector("notes.row"));

        // The note is IN the trash (soft), not gone (MYND-144 reversal
        // of the old non-empty-delete block).
        await (await s.byTestId("notes.trash-open")).click();
        await s.byTestId("trash.panel");
        expect((await s.byTestIdAll("trash.restore")).length).toBe(1);
      },
    );
  });
});
