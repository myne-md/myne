// Command-palette note_search + backlinks + at-rest MYS1 suite
// (search-palette / MYND-231, e2e-wave-2).
//
// Drives three real-IPC surfaces through the production binary:
//
//   sp1 — note_search → specific-result-click → navigate + at-rest MYS1.
//     Seeds ≥2 notes whose bodies share a query token through the real
//     save → reindex pipeline (`vaultIndicesApply`, the tb1 pattern — no
//     test hook). Opens the command palette (Control+k chord), types the
//     query, asserts the hit count, then clicks the ONE result row whose
//     `data-note-id` matches the target (the SYNC-W2-3 discriminator) and
//     asserts the editor navigated to THAT note, not a sibling hit. After
//     the lock-triggered index persist, asserts `vault.search` carries the
//     load-bearing MYS1 header (magic + both version bytes + header
//     length) — the positive control parallel to PS-1's MY01 note-blob
//     assert (a residue scan proves the index is plaintext-free; this
//     proves a silent format/version regression hasn't shipped).
//
//   bl1 — backlinks render → click → navigate (MYND-195). Creates note A,
//     then note B whose body links `[[A]]` (real save → reindex), opens A,
//     asserts the live `backlinks()` pane shows B's source card
//     (`editor.backlink-row[data-source-id=<B>]`), clicks it, and asserts
//     navigation to B.
//
// Coverage boundary (recorded on MYND-231, per the e2e/AGENTS.md downgrade
// rule): the graph-only index surfaces — `vault_indices_orphans`,
// `vault_indices_all_edges`, forward-links, and the GraphView tag/orphans
// filters — are reachable ONLY through GraphView, which carries zero
// testids (its toggle has an `aria-label` only). Per the byTestId-only
// selector rule they are DOWNGRADED to Vitest component / Rust-unit
// coverage until GraphView gets a testid pass (out of this slice's scope).
// The tag index is already E2E-covered by `tb1` (tag-browser.e2e.ts,
// MYND-46) — referenced here, NOT duplicated.
//
// KDF: weak generator fixtures (legal — unlock reads params from
// vault.meta; no production-KDF story here). The note body/title tokens
// are in-source scenario content, not credentials; the password is the
// VR-1-style in-source constant (SYNC-13 applies to credentials, which
// never reach any assert below).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { assertSearchIndexMagic, seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  editorText,
  searchAndOpenNote,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Read the `data-note-id` of the currently-selected sidebar row — the
 *  note `createNote` just created and left selected. The byTestId-only
 *  path to capturing a live-created note's id (the sidebar row carries
 *  `aria-selected="true"` + `data-note-id`). */
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

/** Count the NOTES-section hit rows currently rendered in the palette
 *  (`data-kind="note"` distinguishes them from COMMAND rows that share
 *  the `palette.option` testid). */
async function noteHitCount(s: Session): Promise<number> {
  const rows = await s.findElements(
    testIdSelector("palette.option", { "data-kind": "note" }),
  );
  return rows.length;
}

describeE2E("sp1 note_search → result-click → navigate + MYS1 (MYND-231)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("searches, opens the specific result, and the index persists as MYS1", async () => {
    // Shared query token both note bodies match; per-note unique tail tokens
    // pin WHICH note opened. Leading space gives the inline content a clean
    // word boundary after typeIntoEditor's sacrificial probe char.
    const QUERY = "quokkaledger";
    const ALPHA_BODY = ` ${QUERY} alphatail8x2k`;
    const BETA_BODY = ` ${QUERY} betatail5m9w`;
    let vaultId = "";
    let password = "";
    await scenario(
      "sp1-search-navigate",
      {
        seed: (dir) => {
          const v = seedVault(dir);
          vaultId = v.vaultId;
          password = v.password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Two notes whose bodies both contain QUERY (real save → reindex).
        await createNote(s, "Alpha Note");
        await typeIntoEditor(s, ALPHA_BODY);
        await waitForSaved(s);
        const alphaId = await selectedNoteId(s);

        await createNote(s, "Beta Note");
        await typeIntoEditor(s, BETA_BODY);
        await waitForSaved(s);
        const betaId = await selectedNoteId(s);

        expect(alphaId).not.toBe(betaId);

        // Open the palette, type the shared query, and assert BOTH notes hit.
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
        await (await s.byTestId("palette.input")).sendKeys(QUERY);
        await s.waitUntil(async () => ((await noteHitCount(s)) === 2 ? true : null), {
          label: "note_search → 2 hits",
        });
        // Close the palette before re-opening it via the helper (Esc).
        await (await s.byTestId("palette.input")).sendKeys("\uE00C"); // Escape (W3C code point)
        await s.waitForGone(testIdSelector("palette.input"));

        // Click the SPECIFIC result for Beta → the editor opens Beta, not Alpha.
        await searchAndOpenNote(s, QUERY, betaId);
        await s.waitUntil(
          async () => ((await editorText(s)).includes("betatail5m9w") ? true : null),
          { label: "Beta note opened (not the Alpha sibling)" },
        );
        // Negative side of the same assert: the Alpha-only tail is absent.
        expect((await editorText(s)).includes("alphatail8x2k")).toBe(false);

        // Lock — the deterministic trigger of the encrypted search-index
        // persist (vault_unlock/commands.rs; PS-1 scan (b) relies on the
        // same point). vault.search now exists on disk as MYS1.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");

        // Positive MYS1 at-rest assert: magic + both version bytes + header
        // length (parallel to PS-1's MY01 control on the .myn blob).
        assertSearchIndexMagic(app.appDataDir, vaultId);
      },
    );
  });
});

describeE2E("bl1 backlinks render → click → navigate (MYND-195)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("shows B's backlink card on A and navigates to B when clicked", async () => {
    // B's body links [[A]]. A's unique tail confirms A is the open note when
    // the backlink pane is read; B's tail confirms the click navigated to B.
    const A_BODY = " atailbk4q7z";
    const B_LINK_BODY = " [[Note A]] btailbk2p8r";
    let password = "";
    await scenario(
      "bl1-backlinks-navigate",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Note A — the link target.
        await createNote(s, "Note A");
        await typeIntoEditor(s, A_BODY);
        await waitForSaved(s);
        const aId = await selectedNoteId(s);

        // Note B — links [[Note A]] in its body (real save → reindex).
        await createNote(s, "Note B");
        await typeIntoEditor(s, B_LINK_BODY);
        await waitForSaved(s);
        const bId = await selectedNoteId(s);

        // Open A via its sidebar row; the backlinks pane re-queries on the
        // vault-wide index nonce, so B's card appears.
        await (
          await s.waitForElement(testIdSelector("notes.row", { "data-note-id": aId }))
        ).click();
        await s.waitUntil(
          async () => ((await editorText(s)).includes("atailbk4q7z") ? true : null),
          { label: "Note A opened" },
        );

        // Right-panel tabs (right-panel tabs): backlinks now lives behind its
        // tab. It is the default-active tab, but activate it explicitly so this
        // scenario stays robust to a default-tab change.
        await (
          await s.waitForElement(
            testIdSelector("editor.right-panel-tab", { "data-panel-tab-id": "backlinks" }),
          )
        ).click();

        // B's backlink source card is visible on A.
        const card = await s.waitForElement(
          testIdSelector("editor.backlink-row", { "data-source-id": bId }),
        );
        // Click it → navigate to B (B's unique tail proves the target).
        await card.click();
        await s.waitUntil(
          async () => ((await editorText(s)).includes("btailbk2p8r") ? true : null),
          { label: "clicking the backlink navigated to Note B" },
        );
      },
    );
  });
});
