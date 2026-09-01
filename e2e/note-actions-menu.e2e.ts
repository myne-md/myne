// na1 — editor note-actions "…" menu (#233). Vault-count precondition: 1.
//
// Pins the Obsidian-style note-actions menu that sits in the editor's top-right
// while a note is open, against the production binary:
//   - with a note open in the focused pane, the `editor.note-actions-menu`
//     trigger is present; opening it lists every action row by its stable
//     `data-action` (rename / move / duplicate / version-history / the four
//     exports / trash);
//   - one action is driven end-to-end through the REAL CommandContext handler —
//     "Version history" reveals the snapshots panel (a read-only, reversible
//     proof the menu → handler → IPC wiring is live, independent of the seeded
//     note count);
//   - the gate is pinned from the other side: opening the attachments library
//     (centre view ≠ note) hides the trigger, matching the right-sidebar
//     toggle's own gate that the menu floats beside.
//
// SYNC-13: the note title is scenario content, not a credential. KDF: weak
// generator fixtures (unlock reads params from vault.meta).
//
// ⚠️ NEW SCENARIO — authored to the harness conventions but NOT yet validated in
// the container (this dev platform is macOS; the suite is Linux/tauri-driver
// only). Definition of done per e2e/CLAUDE.md is "green 3× consecutive" via
// ./scripts/e2e-buildrun.sh (it adds the note-actions testids to production).
// Run ISOLATED — the full suite contaminates.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  runPaletteAction,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector } from "./support/webdriver";

/** Every `data-action` the menu is contracted to offer for an ordinary note at
 *  its TOP level. The four export formats are not here: they moved behind the
 *  single `export` row's submenu (myne-md/myne#611), which is asserted
 *  separately below because reaching them costs a hover. */
const EXPECTED_ACTIONS = [
  "rename",
  "move",
  "duplicate",
  "version-history",
  "export",
  "trash",
];

/** The formats the `export` row's submenu is contracted to offer. `export-pdf`
 *  is deliberately absent: it is gated behind the `pdfExport` capability
 *  (`src/notes/noteExportMenu.ts`), and asserting it here would pin a host
 *  answer this scenario does not control. */
const EXPECTED_EXPORT_FORMATS = ["export-markdown", "export-html", "export-txt"];

describeE2E("na1 note-actions menu — open, list, run, gate (#233)", () => {
  it("lists the note actions, runs Version history, and hides off a note", async () => {
    let seeded: SeededVault;
    await scenario(
      "na1-note-actions",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);
        await createNote(s, "na1noteactions");

        // A note is open in the focused pane → the actions trigger is present.
        await s.byTestId("editor.note-actions-menu");

        // Open it and assert every contracted action row (by data-action). The
        // menu builds all rows synchronously on open, so one wait for the first
        // row proves the set is materialised.
        await (await s.byTestId("editor.note-actions-menu")).click();
        await s.waitForElement(testIdSelector("editor.note-actions-menu-item"));
        const actions = await Promise.all(
          (await s.byTestIdAll("editor.note-actions-menu-item")).map((i) =>
            i.attribute("data-action"),
          ),
        );
        for (const a of EXPECTED_ACTIONS) {
          expect(actions, `note-actions menu offers "${a}"`).toContain(a);
        }
        // The export formats are one level down. Hovering the parent row is what
        // opens them, and the row commits nothing, so this cannot double-fire.
        await (
          await s.waitForElement(
            testIdSelector("editor.note-actions-menu-item", {
              "data-action": "export",
            }),
          )
        ).click();
        const formats = await Promise.all(
          (await s.byTestIdAll("editor.note-actions-menu-item")).map((i) =>
            i.attribute("data-action"),
          ),
        );
        for (const f of EXPECTED_EXPORT_FORMATS) {
          expect(formats, `export submenu offers "${f}"`).toContain(f);
        }

        // Run one real action end-to-end: Version history reveals the snapshots
        // panel (read-only, reversible — no dependence on the seeded note count).
        await (
          await s.waitForElement(
            testIdSelector("editor.note-actions-menu-item", {
              "data-action": "version-history",
            }),
          )
        ).click();
        await s.waitForElement(testIdSelector("snapshots.panel"));

        // Gate from the other side: opening the attachments library flips the
        // centre view away from the note, and the trigger must disappear (the
        // same gate the right-sidebar toggle uses; the two float together).
        await runPaletteAction(s, "attachments.open", "attach");
        await s.byTestId("attachments.library");
        expect(
          (await s.byTestIdAll("editor.note-actions-menu")).length,
          "note-actions trigger is hidden over the attachments library",
        ).toBe(0);
      },
    );
  });
});
