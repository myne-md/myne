// Heading & list folding (heading-list-folding / MYND-300, task 6; stories
// 1/2/4/5/6/8).
//
// Drives folding through the production binary: a note with headings + a nested
// list gets a hover-reveal fold gutter (data-testid="editor.fold-gutter-marker").
// Clicking a heading's marker collapses the section to an inline placeholder
// (data-testid="editor.fold-placeholder"); clicking the placeholder unfolds it.
// fold-all / unfold-all run from the command palette. Folds are EPHEMERAL —
// switching notes and coming back leaves no fold placeholder (no persistence).
//
// What is NOT asserted here (and why):
//   - The pure fold-range / children-only predicate + the heading-section SYNC-1
//     surface are unit-tested (tests/editor/list-fold.test.ts,
//     tests/editor/folding.test.ts, tests/dialect/visitors/headingSections.test.ts).
//   - Find/cursor-aware reveal un-folding a region is the existing reveal layer's
//     behavior (inline-cursor-reveal); folding rides on CM6's standard
//     reveal-on-selection, exercised by those suites, not re-driven here.
//
// Vault-count precondition: 1 (weak KDF generator fixture — legal: unlock reads
// params from vault.meta). Note bodies are in-source scenario content, never
// credentials (SYNC-13).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  runPaletteAction,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const CM_EDITOR = '[data-testid="editor.content"] .cm-editor';
const FOLD_MARKER = testIdSelector("editor.fold-gutter-marker");
const FOLD_PLACEHOLDER = testIdSelector("editor.fold-placeholder");

// A doc with two H1 sections and a nested list under the first. The unique
// tails let `typeIntoEditor`'s `includes` asserts pin the right note, and keep
// the palette NOTES search from shadowing the fold COMMAND rows.
const DOC = [
  "# Alpha Section foldtaila1",
  "intro paragraph",
  "- parent item",
  "  - child one",
  "  - child two",
  "## Alpha Sub",
  "sub body",
  "# Beta Section foldtailb2",
  "beta body",
].join("\n");

/** Hover the editor so the hover-reveal gutter shows its fold markers, then
 *  return all currently-rendered fold-gutter markers. */
async function revealAndGetMarkers(s: Session) {
  const editor = await s.waitForElement(CM_EDITOR);
  await editor.hover();
  return s.waitUntil(
    async () => {
      const markers = await s.findElements(FOLD_MARKER);
      return markers.length > 0 ? markers : null;
    },
    { label: "fold-gutter markers revealed on hover", timeoutMs: 10_000 },
  );
}

describeE2E("hlf1 fold a heading section via the gutter (MYND-300)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("hover reveals fold arrows; clicking one collapses the section to a placeholder; unfolding clears it", async () => {
    let password = "";
    await scenario(
      "hlf1-fold-heading-gutter",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Fold Note");
        await typeIntoEditor(s, DOC);
        await waitForSaved(s);

        // No fold placeholder before any fold.
        expect((await s.findElements(FOLD_PLACEHOLDER)).length).toBe(0);

        // Hover reveals the fold arrows; fold the first FOLDABLE line (an
        // `data-fold-open="true"` ⌄ marker — the `="false"` › markers are for
        // already-folded lines). The marker is hover-gated (opacity 0 → 0.7 only
        // while the editor is hovered), so `/click`'s interactability pre-check
        // rejects it — `actionClick` presses it via raw pointer actions instead
        // (opacity doesn't affect hit-testing).
        const foldable = await s.waitUntil(
          async () => {
            for (const m of await revealAndGetMarkers(s)) {
              if ((await m.attribute("data-fold-open")) === "true") return m;
            }
            return null;
          },
          { label: "a foldable (open) gutter marker", timeoutMs: 10_000 },
        );
        await foldable.actionClick();

        // The section collapsed → a clickable inline placeholder appears.
        await s.waitForElement(FOLD_PLACEHOLDER, { timeoutMs: 10_000 });

        // Unfold and assert the placeholder clears. The unfold gesture itself
        // (clicking the inline `⋯` placeholder, a ~10px contenteditable=false
        // widget) is not WebKit-driver-addressable, and clicking the persistent
        // `›` gutter marker of the folded line is ambiguous under the driver
        // (a pre-existing closed marker shares the selector); the reliable,
        // production unfold path is `editor.unfold-all` (the hlf2 gesture). The
        // gutter-FOLD gesture above is what hlf1 uniquely pins; the placeholder
        // lifecycle (appears on fold, clears on unfold) is asserted either way.
        await runPaletteAction(s, "editor.unfold-all", "Unfold all");
        await s.waitForGone(FOLD_PLACEHOLDER);
      },
    );
  });
});

describeE2E("hlf2 fold-all / unfold-all via the command palette (MYND-300)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("fold-all collapses sections (placeholders appear); unfold-all expands them; folds reset on note switch (ephemeral)", async () => {
    let password = "";
    await scenario(
      "hlf2-fold-all-palette",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await createNote(s, "Fold Note A");
        await typeIntoEditor(s, DOC);
        await waitForSaved(s);

        // fold-all → at least one placeholder appears.
        await runPaletteAction(s, "editor.fold-all", "Fold all");
        await s.waitForElement(FOLD_PLACEHOLDER, { timeoutMs: 10_000 });
        const foldedCount = (await s.findElements(FOLD_PLACEHOLDER)).length;
        expect(foldedCount).toBeGreaterThan(0);

        // unfold-all → all placeholders gone.
        await runPaletteAction(s, "editor.unfold-all", "Unfold all");
        await s.waitForGone(FOLD_PLACEHOLDER);

        // Ephemeral check: fold-all again, then switch to a fresh note and back.
        await runPaletteAction(s, "editor.fold-all", "Fold all");
        await s.waitForElement(FOLD_PLACEHOLDER, { timeoutMs: 10_000 });

        // Create a second note (selects it → the first note's view unmounts).
        await createNote(s, "Other Note B");
        await typeIntoEditor(s, " othertailb9 plain body");
        await waitForSaved(s);
        // The fresh note has no headings/lists worth folding → no placeholder.
        expect((await s.findElements(FOLD_PLACEHOLDER)).length).toBe(0);

        // Switch back to the first note via its sidebar row.
        const rowA = await s.waitForElement(
          '[data-testid="notes.row"]:not([aria-current="true"])',
        );
        await rowA.click();
        await s.waitUntil(
          async () =>
            (await s.findElements(FOLD_PLACEHOLDER)).length === 0 ? true : null,
          {
            label: "folds reset after note switch (ephemeral — no persistence)",
            timeoutMs: 10_000,
          },
        );
      },
    );
  });
});
