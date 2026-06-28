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
import {
  createNote,
  dismissImporterOffer,
  editorText,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

// createNote / typeIntoEditor / waitForSaved / editorText moved to
// support/flows.ts (shared with the PS-1 plaintext-residue suite).

// W3C code point for Control (the Linux multi-select modifier, MYND-367) —
// escape form, never a literal (the invisible-key hazard).
const CONTROL = "";

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
        // Wait for the CM content to actually MOUNT before asserting the marker.
        // Post-reload the editor re-mounts and re-reads the note from disk; under
        // full-suite cumulative load that can exceed `editorText`'s own 10 s
        // `.cm-content` wait, which would otherwise throw out of the assertion.
        await s.waitForElement('[data-testid="editor.content"] .cm-content', {
          timeoutMs: 30_000,
        });
        await s.waitUntil(async () => (await editorText(s)).includes(MARKER) || null, {
          label: "marker survives the reload",
          timeoutMs: 15_000,
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

describeE2E("dn1 duplicate note via context menu (MYND-332)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("context-menu Duplicate clones the note with a '(kopya)' title", async () => {
    let password = "";
    await scenario(
      "dn1-duplicate-note",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Kaynak Not");

        // One note in the live tree to start with.
        expect((await s.byTestIdAll("notes.row")).length).toBe(1);

        // Duplicate via the row's real right-click context menu.
        await contextMenuPick(s, await s.byTestId("notes.row"), "duplicate");

        // A second row appears; one of the two carries the "(kopya)" title.
        // The optimistic copy briefly shows "Untitled" until refreshOne
        // settles the real frontmatter title in — so poll for both.
        await s.waitUntil(
          async () => {
            const rows = await s.byTestIdAll("notes.row");
            if (rows.length !== 2) return null;
            const texts = await Promise.all(rows.map((r) => r.textContent()));
            return texts.some((t) => t.includes("(kopya)")) || null;
          },
          { label: "duplicate row shows the (kopya) title" },
        );
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
        await (await s.byTestId("notes.new-folder-input")).sendKeys("Arsiv\uE007");
        const folder = await s.byTestId("notes.folder-row");
        await contextMenuPick(s, folder, "new-note");
        await (await s.byTestId("notes.rename-input")).sendKeys("Klasör Notu\uE007");
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

describeE2E("ms1 multi-select bulk move (MYND-367)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("cmd-click gathers a multi-selection; the bulk context menu moves it all into a folder", async () => {
    let password = "";
    await scenario(
      "ms1-multi-select-bulk-move",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // An (empty) destination folder + two root notes to gather. The
        // trailing `\uE007` (W3C Enter) commits the inline new-folder input —
        // without it the input never materializes `notes.folder-row` and the
        // next line times out (the nc4 site above carries the same key).
        await (await s.byTestId("notes.new-folder")).click();
        await (await s.byTestId("notes.new-folder-input")).sendKeys("Arsiv\uE007");
        await s.byTestId("notes.folder-row");
        await createNote(s, "Multi Alfa");
        await createNote(s, "Multi Beta");

        const ids = await s.waitUntil(
          async () => {
            const rows = await s.byTestIdAll("notes.row");
            return rows.length === 2 ? rows : null;
          },
          { label: "two root notes exist" },
        );
        const [aId, bId] = await Promise.all(
          ids.map(async (r) => (await r.attribute("data-note-id")) ?? ""),
        );

        // Plain-click A (opens + single-selects), then Cmd/Ctrl-click B to
        // gather both into the multi-selection (MYND-367: the open note is
        // folded into the set, so the operation covers {A, B}).
        await (
          await s.waitForElement(testIdSelector("notes.row", { "data-note-id": aId }))
        ).click();
        await (
          await s.waitForElement(testIdSelector("notes.row", { "data-note-id": bId }))
        ).modifierClick(CONTROL);
        await s.waitUntil(
          async () =>
            (await s.findElements(testIdSelector("notes.row", { "data-multiselected": "true" })))
              .length === 2 || null,
          { label: "both rows show as multi-selected" },
        );

        // Bulk "Move N notes to…" → pick the folder (path is the item id).
        await (
          await s.waitForElement(testIdSelector("notes.row", { "data-note-id": bId }))
        ).rightClick();
        await (
          await s.waitForElement(
            testIdSelector("notes.context-menu-item", { "data-item-id": "bulk-move" }),
          )
        ).click();
        await (
          await s.waitForElement(
            testIdSelector("notes.context-menu-item", { "data-item-id": "Arsiv/" }),
          )
        ).click();

        // Both notes are now children of the folder: collapsing the (now
        // non-empty) folder hides exactly them, leaving the folder row.
        await s.waitForGone(testIdSelector("notes.row", { "data-multiselected": "true" }));
        await (await s.byTestId("notes.folder-row")).click(); // collapse
        await s.waitForGone(testIdSelector("notes.row"));
        expect((await s.byTestIdAll("notes.folder-row")).length).toBe(1);
      },
    );
  });
});
