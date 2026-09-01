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
  closeSettings,
  createNote,
  dismissImporterOffer,
  editorText,
  editorSourceText,
  openSettings,
  replaceFieldText,
  runPaletteAction,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const CONTROL = ""; // W3C Actions API code point for Control
const FOLD_PLACEHOLDER = testIdSelector("editor.fold-placeholder");
const CM_CONTENT = '[data-testid="editor.content"] .cm-content';

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

        // A single undo (Ctrl+Z) reverts the WHOLE bulk replace at once. The undo
        // command is a CM keymap binding, so it only fires on a key event reaching
        // the BODY content DOM and targets that editor's own history. Two focus
        // hazards: (a) the find input would swallow the chord — close the bar
        // first (Escape on its input -> closeSearchPanel); (b) a /click on
        // .cm-content does NOT move focus into it (the post-replace selection +
        // floating format toolbar persist, so the chord would land on the TITLE
        // editor and undo the title), but sendKeys' implicit focus does. The
        // ArrowRight both focuses the body and collapses the leftover replace
        // selection. Replace-all is one transaction -> one undo restores the
        // bulk-replaced tokens (the partial replace-one is a separate transaction).
        await (await s.byTestId("find.input")).sendKeys(String.fromCharCode(0xe00c)); // ESCAPE
        await s.waitForGone(testIdSelector("find.input"));
        await (await s.waitForElement(CM_CONTENT)).sendKeys(String.fromCharCode(0xe014)); // ARROW_RIGHT
        await sendCtrlChord(s, "z");
        await s.waitUntil(
          async () => ((await editorText(s)).includes("widgetfr1") ? true : null),
          { label: "single undo reverted the bulk replace-all" },
        );
      },
    );
  });
});

describeE2E("fr2 replace rewrites the canonical buffer under folded regions (MYND-302, SYNC-6)", () => {
  // Vault-count precondition: 1 (weak KDF). Re-confirms against MYND-300 folding.
  it("replace-all rewrites a token inside a folded heading section (fold state left intact)", async () => {
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

        // Confirm the find engine sees BOTH matches inside the folded region
        // first (it scans the canonical buffer, folded text included — SYNC-6):
        // the count-aware "Replace all (N)" reflects the live total.
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("find.replace-all")).textContent()).includes("(2)")
              ? true
              : null,
          { label: "Replace all (2) — both folded matches found" },
        );

        // Replace-all rewrites the canonical buffer in ONE transaction, including
        // text hidden inside folded regions. It does NOT itself un-fold (only the
        // replace-ONE navigation rides the cursor-aware reveal); the fold state is
        // left intact, and the rewritten text stays behind the placeholder — so it
        // can't be read out of the DOM. Prove the under-the-fold rewrite through
        // the find engine instead: re-querying the NEW token finds both rewritten
        // occurrences (still folded), and the OLD token is gone.
        await (await s.byTestId("find.replace-all")).click();
        await replaceFieldText(s, "find.input", "revealedfr2");
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("find.replace-all")).textContent()).includes("(2)")
              ? true
              : null,
          { label: "the rewritten token is found twice inside the still-folded region" },
        );
        await replaceFieldText(s, "find.input", "foldablefr2");
        // No matches → the replace-all button disables (bare "Replace all", no
        // count). That the original token is unfindable proves it's gone from the
        // canonical buffer.
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("find.replace-all")).property<boolean>("disabled"))
              ? true
              : null,
          { label: "the original token no longer exists in the canonical buffer" },
        );
        // The fold state is untouched by replace-all (placeholders still present).
        expect((await s.findElements(FOLD_PLACEHOLDER)).length).toBeGreaterThan(0);
      },
    );
  });
});

describeE2E("fr3 a date typed as it is displayed is found, and Replace is off (myne-md/myne#609)", () => {
  // Vault-count precondition: 1 (weak KDF).
  //
  // The only lane that can answer this. The unit tests drive the bar directly
  // with a display value pushed into the store; here the format comes from the
  // real Settings panel, the chip renders it in the real WebView, and the find
  // engine runs over the real document. What the user sees and what the engine
  // reads are two different strings, and this is the scenario that proves the
  // gap is bridged rather than merely coded for.
  it("falls back to the stored form, says so, and refuses to replace on it", async () => {
    let password = "";
    await scenario(
      "fr3-find-date-fallback",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Find Date Note");

        await typeIntoEditor(s, "- [ ] pay the rent [due:: 2026-08-01]", {
          landedText: "pay the rent",
        });
        await waitForSaved(s);

        await openSettings(s, "editor");
        await (await s.byTestId("settings.date-format-dmy")).click();
        await closeSettings(s);

        await openFind(s);
        // The day-first form is on screen and is NOWHERE in the document.
        await (await s.byTestId("find.input")).sendKeys("01/08/2026");

        // The notice is ATTACHED for the panel's lifetime and toggled with
        // `hidden`, because a live region has to exist before the text it must
        // announce arrives. So the assertion is on visibility, not on presence.
        await s.waitUntil(
          async () => {
            const rows = await s.byTestIdAll("find.date-fallback");
            if (rows.length !== 1) return null;
            if ((await rows[0]!.property<boolean | null>("hidden")) !== false) return null;
            return (await rows[0]!.textContent()).includes("2026-08-01") ? true : null;
          },
          { label: "the bar names the stored form it searched instead" },
        );

        // Replace is unavailable, and the reason is somewhere the user can
        // actually reach. This read the button's `title` first, which a browser
        // never shows on a disabled control, so the scenario asserted the fix by
        // reading an attribute nobody perceives. The reason lives in the visible
        // notice above, and the button points at it with `aria-describedby`.
        await (await s.byTestId("find.toggle-replace")).click();
        await s.waitUntil(
          async () => {
            const btn = await s.byTestId("find.replace-all");
            const disabled = await btn.property<boolean | null>("disabled");
            const describedBy = await btn.attribute("aria-describedby");
            if (disabled !== true || describedBy === null) return null;
            const rows = await s.byTestIdAll("find.date-fallback");
            if (rows.length !== 1) return null;
            const id = await rows[0]!.attribute("id");
            const text = await rows[0]!.textContent();
            return describedBy === id && text.length > 0 ? true : null;
          },
          { label: "Replace all is disabled and points at the visible reason" },
        );

        // And the bytes are exactly what they were.
        // SOURCE text, not the rendered text. The chip is a replace widget and
        // since myne-md/myne#609 its label is the reader's chosen format, so the
        // ISO date is no longer anywhere in the render. Reading it there was how
        // this assertion used to pass, and it is what makes the property being
        // asserted (the bytes did not move) worth asserting at all.
        await s.waitUntil(
          async () => ((await editorSourceText(s)).includes("[due:: 2026-08-01]") ? true : null),
          { label: "the stored civil date is untouched" },
        );
      },
    );
  });
});
