// Persistent-view suite (MYND-534). Proves the pane reuses ONE CodeMirror view
// across note switches so per-note undo history survives — the core acceptance
// of the persistent-EditorView refactor.
//
//   pv1 — UNDO SURVIVES A SWITCH: type an edit in note A, open note B (A stays
//         open in a background tab), switch back to A's tab, press undo, and
//         assert the edit reverted. Pre-change this fails: A's view was torn
//         down + rebuilt empty on every open, so its undo stack was gone.
//   pv2 — CONTENT ISOLATION ACROSS SWITCH: A and B keep their own bodies across
//         a round-trip (no bleed from the shared persistent view).
//
// AUTHORED ON A NON-HARNESS HOST (macOS) — pending green-3× verification on the
// Linux tauri-driver container (the e2e DoD; `./scripts/e2e-local.sh`).
//
// KDF: weak generator fixtures (SYNC-9 — params are vault.meta-resident).

import { it } from "vitest";
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

// Distinct single-token markers (residue needle rule).
const EDIT_MARKER = "alphaedit7k2m9qx4w8e5rj0";
const NOTE_A = "persistviewalpha7c2vb5kk0";
const NOTE_B = "persistviewbeta9d3wc6ll1";

// W3C Actions Control chord (the Linux harness accelerator is Control), sidesteps
// the invisible-U+E007 sendKeys hazard — same pattern as hotkeys.e2e.ts.
const CONTROL = "";
async function sendCtrlChord(session: Session, key: string): Promise<void> {
  await session.send("POST", "/actions", {
    actions: [
      {
        type: "key",
        id: "kbd",
        actions: [
          { type: "keyDown", value: CONTROL },
          { type: "keyDown", value: key },
          { type: "keyUp", value: key },
          { type: "keyUp", value: CONTROL },
        ],
      },
    ],
  });
}

/** The DOM-order note-row ids once exactly `expected` rows exist. */
async function noteRowIds(session: Session, expected: number): Promise<string[]> {
  const rows = await session.waitUntil(
    async () => {
      const found = await session.byTestIdAll("notes.row");
      return found.length === expected ? found : null;
    },
    { label: `${expected} note rows`, timeoutMs: 15_000 },
  );
  return Promise.all(rows.map(async (r) => (await r.attribute("data-note-id")) ?? ""));
}

/** Click the open tab for `noteId` to make it the active buffer in its pane. */
async function switchToNoteTab(session: Session, noteId: string): Promise<void> {
  await (
    await session.waitForElement(
      testIdSelector("editor.tab", { "data-tab-id": `note:${noteId}` }),
    )
  ).click();
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

        // Note A, then an edit we will try to undo after a round-trip.
        await createNote(s, NOTE_A);
        const [aId] = await noteRowIds(s, 1);
        await typeIntoEditor(s, EDIT_MARKER);
        await waitForSaved(s);

        // Note B opens in a new tab (A stays resident in a background tab).
        await createNote(s, NOTE_B);
        await noteRowIds(s, 2);

        // Back to A, then undo — the edit must revert, which requires A's view
        // (and its undo history) to have survived the switch.
        await switchToNoteTab(s, aId);
        await sendCtrlChord(s, "z");

        await s.waitUntil(
          async () => (!(await editorText(s)).includes(EDIT_MARKER) ? true : null),
          { label: "undo reverted the pre-switch edit in note A" },
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

        await createNote(s, NOTE_A);
        const [aId] = await noteRowIds(s, 1);
        await typeIntoEditor(s, EDIT_MARKER);
        await waitForSaved(s);

        await createNote(s, NOTE_B);
        await noteRowIds(s, 2);

        // Back to A: it must show A's body (with the marker), not B's.
        await switchToNoteTab(s, aId);
        await s.waitUntil(
          async () => ((await editorText(s)).includes(EDIT_MARKER) ? true : null),
          { label: "note A restored with its own body" },
        );
      },
    );
  });
});
