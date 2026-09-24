// sq-op1 — search query-language operators in the command palette
// (MYND-303 field operators + MYND-307 boolean/negation). Proves the parser →
// FilterNode → engine wiring end-to-end through the PRODUCTION bundle: an
// operator query scopes the NOTES section exactly, and a plain query still
// returns the unchanged BM25 set (no regression for the common case).
//
// Vault-count precondition: 1 (weak KDF).
//
// The needles below are in-source scenario content, not credentials (SYNC-13):
// a shared body token all three notes match, plus per-note tags/titles that the
// operators discriminate on. This scenario reuses the sp1 mechanics verbatim
// (Ctrl+K to open, `palette.option[data-kind="note"]` rows, `data-note-id` the
// discriminator); only the queries + assertions are new.
//
// DoD reminder (e2e/AGENTS.md): certify with `./scripts/e2e-buildrun.sh
// search-query-operators` green 3× consecutive in the container — this touches
// production code (the palette + parser), so a rebuild is required.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** The `data-note-id` of the currently-selected sidebar row (the note
 *  `createNote` just created and left selected). */
async function selectedNoteId(s: Session): Promise<string> {
  const row = await s.waitForElement(
    '[data-testid="notes.row"][aria-selected="true"]',
  );
  const id = await row.attribute("data-note-id");
  if (id === null || id === "") {
    throw new Error("selected notes.row carried no data-note-id");
  }
  return id;
}

/** The set of note-hit ids currently rendered in the palette NOTES section
 *  (`data-kind="note"` separates them from COMMAND rows sharing the testid). */
async function paletteNoteHitIds(s: Session): Promise<Set<string>> {
  const rows = await s.findElements(
    testIdSelector("palette.option", { "data-kind": "note" }),
  );
  const ids = new Set<string>();
  for (const row of rows) {
    const id = await row.attribute("data-note-id");
    if (id !== null && id !== "") ids.add(id);
  }
  return ids;
}

/** Open the palette (Ctrl+K), type `query`, wait until the NOTES section
 *  settles to `expectedCount` hits, capture their ids, then close (Esc) so the
 *  next query opens fresh (the palette resets its query on open). */
async function runPaletteQuery(
  s: Session,
  query: string,
  expectedCount: number,
): Promise<Set<string>> {
  const CONTROL = "\uE009"; // W3C Actions API code point for Control
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
  await (await s.byTestId("palette.input")).sendKeys(query);
  await s.waitUntil(
    async () =>
      (await paletteNoteHitIds(s)).size === expectedCount ? true : null,
    { label: `query "${query}" → ${expectedCount} hit(s)` },
  );
  const ids = await paletteNoteHitIds(s);
  await (await s.byTestId("palette.input")).sendKeys("\uE00C"); // Escape
  await s.waitForGone(testIdSelector("palette.input"));
  return ids;
}

describeE2E("sq-op1 palette operator queries scope the NOTES section (MYND-303/307)", () => {
  it("tag:/-tag:/file:/OR each scope correctly; a plain query is unchanged", async () => {
    // A shared token all three notes match; per-note tags + distinct titles the
    // operators discriminate on. Leading space gives each inline token a clean
    // word boundary after typeIntoEditor's sacrificial probe char.
    const SHARED = "zephyrquokka";
    const ALPHA_BODY = ` ${SHARED} alphaonly #work `;
    const BETA_BODY = ` ${SHARED} betaonly #home `;
    const GAMMA_BODY = ` ${SHARED} gammaonly `;
    let password = "";
    await scenario(
      "sq-op1-operators",
      {
        seed: (dir) => {
          const v = seedVault(dir);
          password = v.password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await createNote(s, "Alpha Report");
        await typeIntoEditor(s, ALPHA_BODY);
        await waitForSaved(s);
        const alphaId = await selectedNoteId(s);

        await createNote(s, "Beta Ledger");
        await typeIntoEditor(s, BETA_BODY);
        await waitForSaved(s);
        const betaId = await selectedNoteId(s);

        await createNote(s, "Gamma Notes");
        await typeIntoEditor(s, GAMMA_BODY);
        await waitForSaved(s);
        const gammaId = await selectedNoteId(s);

        expect(new Set([alphaId, betaId, gammaId]).size).toBe(3);

        // Baseline: a plain query keeps the unchanged BM25 path → all three.
        expect(await runPaletteQuery(s, SHARED, 3)).toEqual(
          new Set([alphaId, betaId, gammaId]),
        );

        // tag: scopes to the #work note only.
        expect(await runPaletteQuery(s, `${SHARED} tag:work`, 1)).toEqual(
          new Set([alphaId]),
        );

        // -tag: negation excludes the #work note.
        expect(await runPaletteQuery(s, `${SHARED} -tag:work`, 2)).toEqual(
          new Set([betaId, gammaId]),
        );

        // file: matches on the (derived) title only → Alpha Report.
        expect(await runPaletteQuery(s, "file:alpha", 1)).toEqual(
          new Set([alphaId]),
        );

        // OR unions two tag scopes → the two tagged notes (Gamma is untagged).
        expect(await runPaletteQuery(s, "tag:work OR tag:home", 2)).toEqual(
          new Set([alphaId, betaId]),
        );
      },
    );
  });
});
