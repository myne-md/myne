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
  clickNewItem,
  clickRibbonUntilVisible,
  confirmDeleteWithEnter,
  createNote,
  dismissImporterOffer,
  editorText,
  nameNewNote,
  reopenNoteAfterReload,
  runPaletteAction,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
  contextMenuPick,
} from "./support/flows";
import { testIdSelector } from "./support/webdriver";
import { KEY, pressKey } from "./support/keyboard";

// createNote / typeIntoEditor / waitForSaved / editorText moved to
// support/flows.ts (shared with the PS-1 plaintext-residue suite).

// W3C code point for Control (the Linux multi-select modifier, MYND-367) —
// escape form, never a literal (the invisible-key hazard).
const CONTROL = "";

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
        // Reopen the note + wait for the editor body to MOUNT before asserting —
        // the post-reload row click can race the editor remount under load and
        // silently not open the note (empty note-switcher), failing the marker.
        await reopenNoteAfterReload(s);
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
        await clickRibbonUntilVisible(s, "trash.open", "trash.panel");
        await s.byTestId("trash.panel");
        await (await s.byTestId("trash.restore")).click();
        await s.waitForGone(testIdSelector("trash.restore"));
        await (await s.byTestId("trash.close")).click();
        await s.byTestId("notes.row");

        // Trash again, then PERMANENT delete — this one confirms.
        await contextMenuPick(s, await s.byTestId("notes.row"), "delete");
        await s.waitForGone(testIdSelector("notes.row"));
        await clickRibbonUntilVisible(s, "trash.open", "trash.panel");
        await (await s.byTestId("trash.delete")).click();
        await (await s.byTestId("delete-confirm.confirm")).click();
        await s.waitForGone(testIdSelector("trash.delete"));
        await (await s.byTestId("trash.close")).click();
        expect((await s.byTestIdAll("notes.row")).length).toBe(0);
      },
    );
  });
});

describeE2E("nc5 keyboard Delete confirms before soft-trash (MYND-487)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("Delete key opens a confirm gate; Escape cancels, Enter soft-trashes", async () => {
    let password = "";
    await scenario(
      "nc5-keyboard-delete-confirm",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Klavye Adayı");

        // Select the row in the sidebar so focus leaves the editor body — the
        // document-level Delete handler deliberately ignores keypresses that
        // originate in the CodeMirror contenteditable.
        await (await s.byTestId("notes.row")).click();

        // Delete key → confirmation gate (MYND-487), NOT an immediate trash.
        await pressKey(s, KEY.DELETE);
        await s.byTestId("delete-confirm.confirm");

        // Escape cancels — the note stays in the live tree.
        await pressKey(s, KEY.ESCAPE);
        await s.waitForGone(testIdSelector("delete-confirm.confirm"));
        await s.byTestId("notes.row");

        // Delete again → confirm; the confirm button holds initial focus (the
        // component default since #628), so Enter soft-trashes it.
        await (await s.byTestId("notes.row")).click();
        await pressKey(s, KEY.DELETE);
        await confirmDeleteWithEnter(s);
        await s.waitForGone(testIdSelector("notes.row"));

        // Soft-trash, not gone — the note is recoverable from the Trash panel.
        await clickRibbonUntilVisible(s, "trash.open", "trash.panel");
        await s.byTestId("trash.panel");
        expect((await s.byTestIdAll("trash.restore")).length).toBe(1);
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
        await clickNewItem(s, "notes.new-folder");
        await (await s.byTestId("notes.new-folder-input")).sendKeys("Arsiv\uE007");
        const folder = await s.byTestId("notes.folder-row");
        await contextMenuPick(s, folder, "new-note");
        await nameNewNote(s, "Klasör Notu");
        await s.byTestId("notes.row");

        // Folder delete: non-empty → confirm → subtree soft-trashes.
        await contextMenuPick(s, await s.byTestId("notes.folder-row"), "delete");
        await (await s.byTestId("delete-confirm.confirm")).click();
        await s.waitForGone(testIdSelector("notes.folder-row"));
        await s.waitForGone(testIdSelector("notes.row"));

        // The note is IN the trash (soft), not gone (MYND-144 reversal
        // of the old non-empty-delete block).
        await clickRibbonUntilVisible(s, "trash.open", "trash.panel");
        await s.byTestId("trash.panel");
        expect((await s.byTestIdAll("trash.restore")).length).toBe(1);
      },
    );
  });
});

describeE2E("nc7 Enter confirms the folder-delete gate (#628)", () => {
  // Vault-count precondition: 1 (weak KDF).
  //
  // Twin of nc5, which covers the note soft-trash gate. This one is the FOLDER
  // delete, which used to be the cancel-focused variant: the ring sat on Cancel
  // while the accent-filled primary button was Delete, and #397 had made Enter a
  // deliberate no-op there (before that it silently activated Cancel, a close
  // indistinguishable from a successful delete).
  //
  // #628 makes Enter follow the focus RING: focus lands on the destructive
  // button, so the reflex press confirms, and a user who Tabs to Cancel gets an
  // Enter that cancels. `docs/decisions/ui/0564` records it. Escape is asserted
  // first here, because a confirming Enter is only safe if the way out works.
  it("Escape cancels; Enter deletes the folder and its notes move to Trash", async () => {
    let password = "";
    await scenario(
      "nc7-folder-delete-enter-confirms",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Folder + a note inside it (same setup as nc4).
        await clickNewItem(s, "notes.new-folder");
        await (await s.byTestId("notes.new-folder-input")).sendKeys("Arsiv\uE007");
        const folder = await s.byTestId("notes.folder-row");
        await contextMenuPick(s, folder, "new-note");
        await nameNewNote(s, "Klasör Notu");
        await s.byTestId("notes.row"); // the in-folder note settled (as in nc4)

        // Escape still cancels, and nothing is deleted.
        await contextMenuPick(s, await s.byTestId("notes.folder-row"), "delete");
        await s.byTestId("delete-confirm.confirm");
        await pressKey(s, KEY.ESCAPE);
        await s.waitForGone(testIdSelector("delete-confirm.confirm"));
        await s.byTestId("notes.folder-row");

        // Enter confirms. The discriminating assertion: under the #397
        // behaviour the modal would still be open here and the folder present.
        await contextMenuPick(s, await s.byTestId("notes.folder-row"), "delete");
        await s.byTestId("delete-confirm.confirm");
        await pressKey(s, KEY.ENTER);
        await s.waitForGone(testIdSelector("delete-confirm.confirm"));
        await s.waitForGone(testIdSelector("notes.folder-row"));

        // Soft-trash, not gone. The in-folder note is recoverable, which is
        // what the dialog's own warning copy promises.
        await clickRibbonUntilVisible(s, "trash.open", "trash.panel");
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
        await clickNewItem(s, "notes.new-folder");
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

        // The picker is a TREE, not a flat indented list (myne#952). Its whole
        // point is the disclosure: the folder sits one level under the root row
        // and can be folded away, which the old leading-spaces list could not
        // do. Asserted through the driver because the depth is a rendered
        // attribute and the fold is a DOM removal — a jsdom test sees the same
        // thing, but only here does it sit between a real vault and a real move.
        const folderItem = testIdSelector("notes.context-menu-item", {
          "data-item-id": "Arsiv/",
        });
        const rootDisclosure =
          testIdSelector("notes.context-menu-item", {
            "data-item-id": "__vault_root__",
          }) + ' [data-testid="notes.context-menu-disclosure"]';
        expect(
          await (await s.waitForElement(folderItem)).attribute("data-depth"),
        ).toBe("1");

        // Fold the root away: its child goes. Unfold: it comes back.
        await (await s.waitForElement(rootDisclosure)).click();
        await s.waitForGone(folderItem);
        await (await s.waitForElement(rootDisclosure)).click();
        await (await s.waitForElement(folderItem)).click();

        // The bulk move lands both notes inside the folder, which defaults to
        // collapsed (NoteList `expanded` starts empty) — so the moved notes are
        // already hidden. Wait for the selection to clear, then EXPAND the folder
        // to confirm BOTH landed inside, then COLLAPSE to confirm the fold hides
        // exactly them, leaving just the folder row.
        await s.waitForGone(testIdSelector("notes.row", { "data-multiselected": "true" }));
        await (await s.byTestId("notes.folder-row")).click(); // expand
        await s.waitUntil(
          async () => ((await s.byTestIdAll("notes.row")).length === 2 ? true : null),
          { label: "both moved notes appear under the expanded folder" },
        );
        await (await s.byTestId("notes.folder-row")).click(); // collapse
        await s.waitForGone(testIdSelector("notes.row"));
        expect((await s.byTestIdAll("notes.folder-row")).length).toBe(1);
      },
    );
  });
});

describeE2E("nc6 deleting a PINNED open note closes its tab (myne-md/myne#819)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("palette Move-to-trash closes the pinned tab; the note stays trashed after reload", async () => {
    let password = "";
    await scenario(
      "nc6-delete-pinned-open-note",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Sabitlenmiş Not");

        // The created note is open in the focused pane's tab. Read its id from
        // the tab handle, then PIN it: a pinned tab was close-protected, which
        // is exactly why a deleted pinned note used to stay open and editable
        // (the `closeTab` pin guard `closeNoteEverywhere` inherited).
        const tab = await s.byTestId("editor.tab");
        const tabId = (await tab.attribute("data-tab-id")) ?? "";
        expect(tabId.startsWith("note:")).toBe(true);
        const noteId = tabId.slice("note:".length);
        await contextMenuPick(s, tab, "tab.pin");
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("editor.tab")).attribute("data-pinned")) === "true"
              ? true
              : null,
          { label: "the note's tab reports data-pinned=true" },
        );

        // Delete through the COMMAND PALETTE ("Move to trash") — the surface the
        // #825 fix left open (it closed tabs from the sidebar context menu and
        // the Trash panel, but not from the palette / editor "..." menu).
        await runPaletteAction(s, "note.trash", "trash");

        // The tab MUST be gone, pinned or not.
        await s.waitForGone(
          testIdSelector("editor.tab", { "data-tab-id": `note:${noteId}` }),
        );
        expect((await s.byTestIdAll("notes.row")).length).toBe(0);

        // And the note is really trashed, not resurrected: it is restorable
        // from the Trash panel, and it stays out of the live tree after a
        // reload (a resurrected note would be back as a live row).
        await clickRibbonUntilVisible(s, "trash.open", "trash.panel");
        await s.byTestId("trash.panel");
        expect((await s.byTestIdAll("trash.restore")).length).toBe(1);
        await (await s.byTestId("trash.close")).click();
        await s.waitForGone(testIdSelector("trash.panel"));

        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
        expect((await s.byTestIdAll("notes.row")).length).toBe(0);
      },
    );
  });
});
