// "Open random note" command-palette action → deterministic navigate
// (random-note / MYND-323).
//
// Drives the real-IPC palette action through the production binary. The
// command picks uniformly from the live, non-template notes, dropping the
// CURRENTLY-open note when ≥2 are eligible so the pick always moves. With
// exactly two notes seeded and one of them open, the "random" pick is
// therefore DETERMINISTIC — the only eligible "other" note — which is what
// makes this serendipity feature E2E-assertable at all.
//
// Vault-count precondition: 1 (weak KDF generator fixture — legal: unlock
// reads params from vault.meta; the note bodies are in-source scenario
// content, never credentials, so SYNC-13 doesn't bite).

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

/** Read the `data-note-id` of the currently-selected sidebar row — the row
 *  `createNote` just left selected, or the row the random action navigated to
 *  (`aria-selected="true"` + `data-note-id`, the byTestId-only handle). */
async function selectedNoteId(s: Session): Promise<string> {
  const row = await s.waitForElement(
    '[data-testid="notes.row"][aria-current="true"]',
  );
  const id = await row.attribute("data-note-id");
  if (id === null || id === "") {
    throw new Error("selected notes.row carried no data-note-id");
  }
  return id;
}

/** Open the command palette via the Control+K chord (W3C Actions API). */
async function openPalette(s: Session): Promise<void> {
  const CONTROL = "\uE009";
  await s.send("POST", "/actions", {
    actions: [
      {
        type: "key",
        id: "kbd",
        actions: [
          { type: "keyDown", value: CONTROL },
          { type: "keyDown", value: "k" },
          { type: "keyUp", value: "k" },
          { type: "keyUp", value: CONTROL },
        ],
      },
    ],
  });
  await s.byTestId("palette.input");
}

describeE2E("rn1 \"Open random note\" → deterministic navigate (MYND-323)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("opens the OTHER live note when invoked from a two-note vault", async () => {
    // Per-note unique tail tokens pin WHICH note the editor navigated to. The
    // leading space gives the inline content a clean word boundary after
    // typeIntoEditor's sacrificial probe char. No "random" substring in bodies
    // so the palette's NOTES search can't shadow the COMMAND row.
    const ALPHA_BODY = " alphatailx9k2vd";
    const BETA_BODY = " betatailm7w5qp";
    let password = "";
    await scenario(
      "rn1-random-note-navigate",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Two live notes (real save → reindex). Beta is created last, so it is
        // the selected/open note when the random action fires.
        await createNote(s, "Alpha Note");
        await typeIntoEditor(s, ALPHA_BODY);
        await waitForSaved(s);
        const alphaId = await selectedNoteId(s);

        await createNote(s, "Beta Note");
        await typeIntoEditor(s, BETA_BODY);
        await waitForSaved(s);
        const betaId = await selectedNoteId(s);

        expect(alphaId).not.toBe(betaId);

        // Open the palette, fuzzy-filter to the command, click its row.
        await openPalette(s);
        await (await s.byTestId("palette.input")).sendKeys("random");
        const option = await s.waitForElement(
          testIdSelector("palette.option", { "data-action-id": "notes.random" }),
        );
        await option.click();
        await s.waitForGone(testIdSelector("palette.input"));

        // Current note was Beta → the only eligible "other" is Alpha, so the
        // random pick is deterministic: the editor navigates to Alpha.
        await s.waitUntil(
          async () => ((await editorText(s)).includes("alphatailx9k2vd") ? true : null),
          { label: "random pick opened the OTHER note (Alpha)" },
        );
        expect((await editorText(s)).includes("betatailm7w5qp")).toBe(false);
        expect(await selectedNoteId(s)).toBe(alphaId);
      },
    );
  });
});
