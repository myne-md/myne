// In-note find-and-replace suite (find-and-replace / MYND-302).
//
// AUTHORED ON A NON-HARNESS HOST (macOS) — pending green-3× verification on the
// Linux tauri-driver container (the e2e DoD; `./scripts/e2e-local.sh`). Follows
// the search-palette.e2e.ts / hotkeys.e2e.ts W3C Actions API chord pattern for
// the Ctrl+F open (the find bar is opened by App.tsx's window-level listener, NOT
// a CM keymap — so a real key chord through the page is the only honest path) and
// the heading-list-folding.e2e.ts fold-gutter pattern for the folded-region proof.
//
// Drives the replace affordance through the production binary:
//
//   fr1 — open find (Ctrl+F) → expand replace (find.toggle-replace) →
//     replace-one (find.replace-one) → replace-all (find.replace-all) → assert the
//     document content, then assert a SINGLE undo (Ctrl+Z) reverts the whole bulk
//     replace (one undoable transaction, story 4).
//
//   fr2 — fold a heading section (fold-all), then run replace-all over a token that
//     lives inside the folded region; assert the replacement landed on the
//     canonical text AND the region un-folded (no placeholder), proving replace
//     scans/reveals folded regions (SYNC-6, story 7). Re-confirm against MYND-300
//     folding (already landed: editor.fold-* testids).
//
// Vault-count precondition: 1 (weak KDF generator fixture — legal: unlock reads
// params from vault.meta). Note bodies/tokens are in-source scenario content,
// never credentials (SYNC-13); the password is the in-source constant class.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  editorText,
  runPaletteAction,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const CONTROL = ""; // W3C Actions API code point for Control
const FOLD_PLACEHOLDER = testIdSelector("editor.fold-placeholder");

/** Send a single `Control+<key>` chord via the W3C Actions API (no sendKeys —
 *  sidesteps the invisible-U+E007 chord hazard, MEMORY e2e note). */
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

/** Open the in-note find bar (App.tsx's window-level Ctrl+F) and wait for its
 *  input — the bar carries no testid on the root, so the find input IS the
 *  open signal. */
async function openFind(session: Session): Promise<void> {
  await sendCtrlChord(session, "f");
  await session.byTestId("find.input", { timeoutMs: 10_000 });
}

describeE2E("fr1 replace-one + replace-all + single-undo (MYND-302)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("opens find, expands replace, replaces one then all, and one undo reverts the bulk replace", async () => {
    // Distinct tail tokens keep typeIntoEditor's `includes` asserts unambiguous.
    const BODY = " widgetfr1 plain widgetfr1 mid widgetfr1 tail";
    let password = "";
    await scenario(
      "fr1-replace-one-all-undo",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Replace Note");
        await typeIntoEditor(s, BODY);
        await waitForSaved(s);

        // Open find, type the query (3 occurrences of "widgetfr1").
        await openFind(s);
        await (await s.byTestId("find.input")).sendKeys("widgetfr1");

        // Reveal the replace row and set the replacement.
        await (await s.byTestId("find.toggle-replace")).click();
        await (await s.byTestId("find.replace-input")).sendKeys("gadgetfr1");

        // The count-aware button reflects the live total (story 3).
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("find.replace-all")).textContent()).includes("(3)")
              ? true
              : null,
          { label: "Replace all (N) shows the live count of 3" },
        );

        // Step onto the first match (Enter in the find input), then replace it.
        await (await s.byTestId("find.input")).sendKeys(""); // Enter
        await (await s.byTestId("find.replace-one")).click();
        await s.waitUntil(
          async () => ((await editorText(s)).includes("gadgetfr1") ? true : null),
          { label: "replace-one produced the first replacement" },
        );

        // Replace-all rewrites every remaining occurrence in one transaction.
        await (await s.byTestId("find.replace-all")).click();
        await s.waitUntil(
          async () => ((await editorText(s)).includes("widgetfr1") ? null : true),
          { label: "replace-all eliminated every 'widgetfr1'" },
        );
        // All three "widgetfr1" are now "gadgetfr1".
        const replaced = await editorText(s);
        expect(replaced.includes("widgetfr1")).toBe(false);

        // A single undo (Ctrl+Z) reverts the WHOLE bulk replace at once. Focus the
        // editor content first so the history command targets the document. The
        // replace-all is one transaction → one undo restores at least one original
        // token (the partial replace-one is a separate transaction).
        await (await s.byTestId("editor.content")).click();
        await sendCtrlChord(s, "z");
        await s.waitUntil(
          async () => ((await editorText(s)).includes("widgetfr1") ? true : null),
          { label: "single undo reverted the bulk replace-all" },
        );
      },
    );
  });
});

describeE2E("fr2 replace reveals + rewrites folded regions (MYND-302, SYNC-6)", () => {
  // Vault-count precondition: 1 (weak KDF). Re-confirms against MYND-300 folding.
  it("replace-all rewrites a token inside a folded heading section and un-folds it", async () => {
    // An H1 section whose body carries the replace target; fold-all collapses it.
    const DOC = [
      "# Section foldfr2head",
      "body line foldablefr2 inside",
      "more body foldablefr2 text",
      "# Tail foldfr2tail",
      "tail body",
    ].join("\n");
    let password = "";
    await scenario(
      "fr2-replace-folded-region",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Folded Replace Note");
        await typeIntoEditor(s, DOC);
        await waitForSaved(s);

        // Collapse the section(s) → at least one fold placeholder appears, hiding
        // the "foldablefr2" body lines behind the heading.
        await runPaletteAction(s, "editor.fold-all", "Fold all");
        await s.waitForElement(FOLD_PLACEHOLDER, { timeoutMs: 10_000 });
        expect((await s.findElements(FOLD_PLACEHOLDER)).length).toBeGreaterThan(0);

        // Open find + replace, target the folded-region token.
        await openFind(s);
        await (await s.byTestId("find.input")).sendKeys("foldablefr2");
        await (await s.byTestId("find.toggle-replace")).click();
        await (await s.byTestId("find.replace-input")).sendKeys("revealedfr2");

        // Replace-all operates on the canonical buffer (folded text included) and
        // the navigation un-folds the region (SYNC-6).
        await (await s.byTestId("find.replace-all")).click();
        await s.waitUntil(
          async () => ((await editorText(s)).includes("revealedfr2") ? true : null),
          { label: "replace-all rewrote the token inside the folded region" },
        );
        // The canonical text no longer carries the original folded-region token.
        expect((await editorText(s)).includes("foldablefr2")).toBe(false);
        // And the region un-folded on the replace navigation (placeholders gone).
        await s.waitForGone(FOLD_PLACEHOLDER);
      },
    );
  });
});
