// Keyboard tab-switch autosave flush (myne#288).
//
// tsf1 — Type into note A, then switch tabs with the KEYBOARD (Ctrl+Tab) while
//        `.cm-content` still holds focus, inside the γ1 idle window. Switch back
//        and confirm the keystrokes are on disk, not merely on screen.
//
// Why this scenario and not a unit test alone: the whole defect lived in the gap
// between two layers that unit tests see separately. The autosave hook reset its
// dirty flag on a note change without saving, AND the pane's cached-EditorState
// swap re-baselined the buffer one effect EARLIER — so the text came back on
// screen from the cache while the bytes were never written. A test that reads
// the hook cannot see the cache, and a test that reads the cache cannot see the
// hook. Only the real app composes them.
//
// The keyboard is load-bearing. A MOUSE click on a tab or a sidebar row blurs
// `.cm-content`, and the blur handler flushes — which is why this was never
// noticed. Every keyboard switch path keeps editor focus by design.
//
// The assertion is on the RELOADED document (Lock → re-unlock drops every cached
// EditorState), so a pass cannot come from the cache that hid the bug.
//
// KDF: weak generator fixtures (SYNC-9 — params are vault.meta-resident).
// SYNC-13: note titles are in-source scenario constants.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  activeNoteId,
  createNote,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  editorText,
  noteRowIds,
  typeIntoEditor,
  unlockToEditor,
} from "./support/flows";
import { type Element, type Session, testIdSelector } from "./support/webdriver";
import { KEY, pressChord } from "./support/keyboard";

// Distinct single lowercase-alnum tokens (residue needle rule).
const TSF_TITLES = ["tsfnotealpha6b3k9wq2m7x5rj1", "tsfnotebravo4h8z1cn5vb2kk7"];
/** The payload that must survive the switch. Prose only — no syntax a live
 *  decoration would replace, so `typeIntoEditor`'s arrival check can pass. */
const TSF_PAYLOAD = "unsavedkeystrokes8w3q";

async function row(session: Session, noteId: string): Promise<Element> {
  return session.waitForElement(testIdSelector("notes.row", { "data-note-id": noteId }));
}

/** Open a note in a NEW tab through the row's real context menu.
 *
 *  NOT `middleClick()`. `workspace-state.e2e.ts` already wrote down why: the
 *  WebDriver synthetic middle-click never fires `auxclick` under WebKit, so the
 *  gesture is a production affordance that is simply not driver-addressable.
 *  The context-menu item invokes the SAME workspace action. This spec was still
 *  using the middle-click and failing on "two tabs open" because the second tab
 *  never opened. */
async function openInNewTab(session: Session, noteId: string): Promise<void> {
  await (await row(session, noteId)).rightClick();
  await (
    await session.waitForElement(
      testIdSelector("notes.context-menu-item", { "data-item-id": "open-in-new-tab" }),
    )
  ).click();
}

describeE2E("tsf1 (myne#288): a keyboard tab switch flushes the pane's edits", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("keeps text typed before a Ctrl+Tab switch, across a lock/unlock reload", async () => {
    let password = "";
    await scenario(
      "tsf1-tab-switch-flush",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        for (const t of TSF_TITLES) await createNote(s, t);
        const [a, b] = await noteRowIds(s, 2);

        // TWO tabs in the focused pane — Ctrl+Tab cycles within a pane, so one
        // tab would make the switch a no-op and the scenario vacuous. A plain
        // sidebar click REUSES the active slot; middle-click is the new-tab
        // affordance (MYND-367 moved it there from Cmd/Ctrl-click).
        await (await row(s, b!)).click();
        await openInNewTab(s, a!);
        await s.waitUntil(
          async () => ((await s.byTestIdAll("editor.tab")).length === 2 ? true : null),
          { label: "tsf1 two tabs open", timeoutMs: 15_000 },
        );
        // Which note is open comes from the TAB STRIP, never from the document
        // text: a note's title lives in the frontmatter block, which live
        // preview replaces with the properties widget, whose title is an input
        // VALUE. `editorText()` on a fresh note is literally
        // "Properties≡+ Add property" — see `activeNoteId`'s own doc.
        await s.waitUntil(async () => ((await activeNoteId(s)) === a ? true : null), {
          label: "tsf1 note A active",
          timeoutMs: 15_000,
        });

        // Type, then switch WITHOUT letting the editor blur — no click, no
        // palette (both of which would flush incidentally).
        await typeIntoEditor(s, TSF_PAYLOAD);
        await pressChord(s, KEY.CONTROL, KEY.TAB);

        // Lock → re-unlock: every cached EditorState is gone, so what comes back
        // is what is on disk.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(s, password);
        // Second editor mount: the importer offer is a FRESH-VAULT overlay and does
        // not re-appear after a lock -> unlock on a vault that already has notes —
        // `dismissImporterOfferIfPresent`'s own doc says so, and the hard variant
        // times out waiting for something that is deliberately absent.
        await dismissImporterOfferIfPresent(s);

        await (await row(s, a!)).click();
        await s.waitUntil(
          async () => ((await editorText(s)).includes(TSF_PAYLOAD) ? true : null),
          { label: "tsf1 typed text survived the keyboard switch", timeoutMs: 20_000 },
        );
        expect(await editorText(s)).toContain(TSF_PAYLOAD);
      },
    );
  });
});
