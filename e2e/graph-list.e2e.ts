// Graph list mode suite (myne-md/myne#727). The graph's canvas has no keyboard
// path and nothing a screen reader can read, so the accessible surface is a
// SECOND rendering of the same model as text. This pins that surface through the
// REAL editor UI:
//
//   gl1, the header's List toggle swaps the canvas for a list of the same view,
//         the canvas is genuinely NOT mounted in list mode, the count is
//         announced, and Enter on a focused row opens that note. Every step
//         after the toggle is keyboard-only, which is the point of the mode
//         existing.
//
// KDF: weak generator fixture (SYNC-9, params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  activeNoteId,
  createNote,
  dismissImporterOffer,
  runPaletteAction,
  unlockToEditor,
} from "./support/flows";

// A few notes so the list has rows to move through. No links between them: the
// row's connection lines are asserted directly in
// `tests/notes/graphList.test.tsx`, where a fixture can hold the exact model,
// and typing wikilinks into the editor is the flaky input path the E2E authoring
// rules warn about.
const TITLES = [
  "gl1notealfa7k2m9qx4w8e5rj0aa",
  "gl1notebravo3f6h1zn8c2vb5kk0",
  "gl1notecharlie9d4e2yp6s1tw3mm",
];

describeE2E("gl1 graph list mode is usable without a pointer", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the List toggle renders the view as text and Enter on a row opens the note", async () => {
    let password = "";
    await scenario(
      "gl1-graph-list",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        for (const t of TITLES) await createNote(s, t);

        // Open the graph as its tab through the palette, then switch the pane
        // body to the list.
        await runPaletteAction(s, "graph.show", "graph");
        await s.byTestId("editor.graph-pane", { timeoutMs: 15_000 });
        // The picture is the default surface, so this also proves the switch is
        // a real change of surface rather than the only thing rendering.
        await s.byTestId("editor.graph-canvas", { timeoutMs: 15_000 });
        await (await s.byTestId("editor.graph-view-list")).click();
        await s.byTestId("editor.graph-list", { timeoutMs: 15_000 });

        const rows = await s.byTestIdAll("editor.graph-list-row");
        expect(rows.length).toBe(TITLES.length);

        // The canvas is not merely hidden: it is not mounted, so list mode never
        // loads the lazy canvas chunk. A reader who wants text never downloads
        // the renderer at all.
        expect((await s.byTestIdAll("editor.graph-canvas")).length).toBe(0);

        // The count is announced, not just drawn: a filter that silently swaps
        // hundreds of notes for three has to say so.
        const announce = await s.byTestId("editor.graph-announce");
        expect(await announce.textContent()).toContain(String(TITLES.length));

        // Keyboard-only from here: focus the first row and activate it with
        // Enter. Enter on a button is the browser's own activation, so this is
        // the real keyboard path and not a synthesised click.
        await rows[0]!.sendKeys("\uE007");
        await s.waitUntil(
          async () => ((await activeNoteId(s)) !== null ? true : null),
          { label: "a note opened from the list row", timeoutMs: 15_000 },
        );
      },
    );
  });
});
