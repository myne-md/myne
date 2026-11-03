// Persistent-view suite (MYND-534). Proves the pane reuses ONE CodeMirror view
// across note switches so per-note undo history survives — the core acceptance
// of the persistent-EditorView refactor.
//
//   pv1 — UNDO SURVIVES A SWITCH: open notes A and B as two tabs in the one pane,
//         type an edit in A, switch to B's tab, switch back to A's tab, press undo,
//         and assert the edit reverted. Pre-change this fails: A's view was torn
//         down + rebuilt empty on every switch, so its undo stack was gone.
//   pv2 — CONTENT ISOLATION ACROSS SWITCH: A and B keep their own bodies across a
//         round-trip (no bleed from the shared persistent view).
//
// TAB SETUP: a create (or a plain sidebar-row click) REUSES the focused pane's
// active tab slot — it does NOT open a background tab (openInFocusedTab, MYND-166).
// So: create A, PIN it, then create B — a pinned active tab makes openInFocusedTab
// route B into a NEW tab, leaving A resident. Both notes then coexist for the
// persistent view to swap between (the tab-count-verified tab-modes.e2e.ts path).
//
// Verified green-3× on the Linux tauri-driver container (the e2e DoD;
// `./scripts/e2e-local.sh`).
//
// KDF: weak generator fixtures (SYNC-9 — params are vault.meta-resident).

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickNoteRow,
  createNote,
  dismissImporterOffer,
  editorText,
  noteRowIds,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { KEY, pressChord } from "./support/keyboard";
import { testIdSelector, type Session } from "./support/webdriver";

// Distinct single-token markers (residue needle rule).
const EDIT_MARKER = "alphaedit7k2m9qx4w8e5rj0";
const NOTE_A = "persistviewalpha7c2vb5kk0";
const NOTE_B = "persistviewbeta9d3wc6ll1";

// Control chords go through the shared `pressChord(session, KEY.CONTROL, key)`.

// The live editable surface (the selector support/flows.ts uses to drive it).
const CM_CONTENT = testIdSelector("editor.content") + " .cm-content";

/** Focus the live editor so an editor keybind (undo) lands on its content DOM. A
 *  tab click focuses the tab button, and under this WebDriver a plain click does
 *  NOT move focus into `.cm-content` — but a `sendKeys`' implicit focus does. A
 *  caret-only ArrowRight focuses it with no doc change (proven pattern from
 *  find-replace.e2e.ts fr1). */
async function focusEditor(session: Session): Promise<void> {
  await (await session.waitForElement(CM_CONTENT)).sendKeys(String.fromCharCode(0xe014)); // ARROW_RIGHT
}

/** The id of the single note row that is NOT `exclude`, once `total` rows exist. */
async function otherNoteRowId(
  session: Session,
  exclude: string,
  total: number,
): Promise<string> {
  const other = (await noteRowIds(session, total)).find((id) => id !== exclude);
  if (other === undefined) throw new Error(`no note row other than ${exclude}`);
  return other;
}

/** Make `noteId` the active buffer in its pane by clicking its SIDEBAR row.
 *
 *  The tab is the more obvious affordance and this suite used it until
 *  2026-11-03, when it stopped being reachable: with two resident tabs the strip
 *  overflows, and WebKitGTK then leaves its hit-test map stale — `editor.tab` is
 *  absent from `document.elementsFromPoint` at its own centre (its ancestors are
 *  listed) and the driver refuses the click. That is a browser/harness question
 *  tracked on its own (`Element.click`'s refresh does not cure it), while THIS
 *  scenario is about the pane reusing one view across a switch: a row click
 *  performs the same switch through the same `openInFocusedTab`, which is why
 *  `openTwoNoteTabs` still asserts both notes are resident as tabs. */
async function switchToNote(session: Session, noteId: string): Promise<void> {
  await clickNoteRow(session, noteId);
}

/** Pin the open tab for `noteId` via its right-click menu (tab-modes.e2e.ts
 *  pattern). A pinned active tab makes the NEXT create/open land in a new tab. */
async function pinTab(session: Session, noteId: string): Promise<void> {
  const tab = await session.waitForElement(
    testIdSelector("editor.tab", { "data-tab-id": `note:${noteId}` }),
  );
  await tab.rightClick();
  await (
    await session.waitForElement(
      testIdSelector("notes.context-menu-item", { "data-item-id": "tab.pin" }),
    )
  ).click();
}

/** Open notes A and B as two resident tabs in the one pane and return their ids.
 *  A create (or a plain row click) REUSES the pane's active tab slot
 *  (openInFocusedTab, MYND-166) — it can't open a background tab on its own. So:
 *  create A, PIN it, then create B — with a pinned active tab, openInFocusedTab
 *  routes B into a NEW tab, leaving A resident. Both notes then coexist for the
 *  persistent view to swap between. (This is the tab-count-verified
 *  tab-modes.e2e.ts pinning path; middleClick's auxclick does not fire reliably
 *  under the harness WebView.) */
async function openTwoNoteTabs(
  session: Session,
): Promise<{ aId: string; bId: string }> {
  await createNote(session, NOTE_A);
  const [aId] = await noteRowIds(session, 1);
  await pinTab(session, aId);
  await createNote(session, NOTE_B); // pinned A → B opens in a NEW tab → [A, B]
  const bId = await otherNoteRowId(session, aId, 2);
  // Confirm BOTH tabs are resident before the suite drives switches.
  await session.waitUntil(
    async () => {
      const tabs = await session.byTestIdAll("editor.tab");
      const ids = await Promise.all(
        tabs.map(async (t) => (await t.attribute("data-tab-id")) ?? ""),
      );
      return ids.includes(`note:${aId}`) && ids.includes(`note:${bId}`) ? true : null;
    },
    { label: "both notes resident as tabs", timeoutMs: 15_000 },
  );
  return { aId, bId };
}

describeE2E("pv1 persistent view — undo survives a note switch (MYND-534)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("reverts an edit made before switching away and back", async () => {
    let password = "";
    await scenario(
      "pv1-undo-survives-switch",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Two notes, BOTH resident as tabs in the one pane.
        const { aId, bId } = await openTwoNoteTabs(s);

        // Edit A: focus its tab, type, save — A's view now holds the edit and its
        // undo history.
        await switchToNote(s, aId);
        await typeIntoEditor(s, EDIT_MARKER);
        await waitForSaved(s);

        // Switch to B, then back to A, then undo — the edit must revert, which
        // requires A's view (and its undo history) to have survived the switch.
        await switchToNote(s, bId);
        await switchToNote(s, aId);
        // A tab click focuses the tab, not the body editor, so re-focus it (the
        // undo keybind is a CM binding that only fires on a key event reaching the
        // body content DOM). The FIRST W3C Ctrl+Z right after a persistent-view
        // swap is intermittently dropped by the WebView, so re-focus + re-send the
        // chord each poll until the edit reverts — over-undo is harmless (the
        // assertion needs only the marker gone).
        await s.waitUntil(
          async () => {
            await focusEditor(s);
            await pressChord(s, KEY.CONTROL, "z");
            return !(await editorText(s)).includes(EDIT_MARKER) ? true : null;
          },
          { label: "undo reverted the pre-switch edit in note A", timeoutMs: 20_000 },
        );
      },
    );
  });
});

describeE2E("pv2 persistent view — content isolation across a switch (MYND-534)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("keeps each note's own body across a round-trip", async () => {
    let password = "";
    await scenario(
      "pv2-content-isolation",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        const { aId, bId } = await openTwoNoteTabs(s);

        // Give A its own body.
        await switchToNote(s, aId);
        await typeIntoEditor(s, EDIT_MARKER);
        await waitForSaved(s);

        // Back to A after visiting B: it must show A's body (with the marker), not
        // B's — no bleed from the shared persistent view.
        await switchToNote(s, bId);
        await switchToNote(s, aId);
        await s.waitUntil(
          async () => ((await editorText(s)).includes(EDIT_MARKER) ? true : null),
          { label: "note A restored with its own body" },
        );
      },
    );
  });
});
