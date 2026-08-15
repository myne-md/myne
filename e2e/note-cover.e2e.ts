// Note-cover lifecycle suite (myne-md/myne#410, e2e).
//
// Stories:
//   nco1 — a note with no cover gets one through the command palette → the
//          banner renders above the title → Change swaps it → Remove clears it
//          and the banner goes.
//   nco2 — a vault with no attachments: the picker says the library is empty
//          rather than showing an empty grid, and a cancelled pick leaves the
//          note coverless.
//
// What this suite settles that the unit tests could not: the banner's ordering
// above the Properties block, and the in-place repaint after a write (the
// `bannerSrc` change assertion). What it does NOT settle is listed at the
// bottom of this file, in the same place it has always been.
//
// The palette is the driving entry point rather than the hover controls,
// because it is the one door that does not depend on a pointer. The hover
// controls are exercised too, through `actionClick`, which is the helper
// written for exactly this shape (opacity-0 until hover; `/click` refuses such
// an element, the Actions API does not).

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  ESCAPE_KEY,
  runPaletteAction,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Open the cover picker through the palette — the keyboard door, and the only
 *  entry point that needs no pointer. */
async function openCoverPicker(s: Session): Promise<void> {
  await runPaletteAction(s, "note.set-cover", "cover");
  await s.byTestId("cover-picker.modal");
}

/** Pick the nth image tile in the open picker. */
async function pickCoverImage(s: Session, index: number): Promise<void> {
  // WAIT for the grid, do not read it once. The picker fills itself from
  // `catalogList()` over IPC, so the tiles arrive a beat after the modal does;
  // `findElements` returns immediately, and indexing into the first (empty)
  // answer is a coin flip on how fast that call resolved.
  const tile = await s.waitUntil(
    async () => (await s.byTestIdAll("cover-picker.image"))[index],
    { label: `cover picker image at index ${index}` },
  );
  await tile.click();
  await s.waitForGone(testIdSelector("cover-picker.modal"));
}

/**
 * Reveal the banner's hover controls and press one.
 *
 * `actionClick` is the right transport (the controls are `opacity: 0` until
 * hover, and `/click` refuses such an element), but it deliberately carries NO
 * retry and no interactability pre-check. The banner re-renders whenever the
 * document or the attachment catalog changes, so a node found before a write
 * can be stale by the time it is pressed — which is exactly the shape that made
 * this scenario need a `retry x1` on one run. Re-finding both elements inside
 * the retry loop removes the window rather than papering over it.
 */
async function pressBannerControl(s: Session, controlTestId: string): Promise<void> {
  await s.waitUntil(
    async () => {
      // `hover()`, not a click: the controls only exist to the pointer while it
      // is over their host, and clicking the banner would be a real pointer
      // press inside the editor at position 0 — moving focus and selection,
      // which is exactly what the production controls' mousedown+preventDefault
      // goes out of its way to avoid.
      await (await s.byTestId("editor.cover-banner")).hover();
      await (await s.byTestId(controlTestId)).actionClick();
      return true;
    },
    { label: `banner control ${controlTestId} pressed` },
  );
}

/** The banner image's current `src` (an `attachment://<id>` URL on desktop).
 *  Asserting the URL CHANGES is the difference between "a banner is there" and
 *  "the banner shows what was just picked". */
async function bannerSrc(s: Session): Promise<string> {
  const img = await s.waitUntil(
    async () =>
      (await s.findElements(`${testIdSelector("editor.cover-banner")} img`))[0],
    { label: "cover banner image" },
  );
  return await img.property<string>("src");
}

/** The `cover` row inside the frontmatter Properties widget, if the widget drew
 *  one. A VALID cover is promoted to the banner and must NOT be repeated here;
 *  an invalid one must be, or the line exists in the file and nowhere in the UI. */
async function coverRowCount(s: Session): Promise<number> {
  const keys = await s.findElements(".cm-fm-properties-list .cm-fm-properties-key");
  let count = 0;
  for (const key of keys) {
    // `property("value")`, not `attribute("value")`: the widget sets the input's
    // live value in JS and never writes a `value=` attribute, so the markup read
    // comes back null for every row.
    if ((await key.property<string>("value")) === "cover") count += 1;
  }
  return count;
}

describeE2E("nco1 cover lifecycle: add, change, remove (myne-md/myne#410)", () => {
  // Vault-count precondition: 1 (weak KDF). `exportSuite` is what puts real
  // MYA1 image attachments + an MYC1 catalog in the vault, so the picker has a
  // grid to pick FROM without driving a native file dialog. It implies a v0.1
  // vault; that is incidental here rather than the point, because the cover
  // field rides the note envelope and has no format dependency of its own.
  it("adds a cover from the palette, swaps it, and removes it", async () => {
    let password = "";
    await scenario(
      "nco1-cover-add-change-remove",
      {
        seed: (dir) =>
          void (password = seedVault(dir, { exportSuite: true }).password),
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Kapaklı Not");

        // No cover yet: no banner, and the "Add cover" control is offered on
        // the promoted title row.
        await s.waitForGone(testIdSelector("editor.cover-banner"));
        await s.byTestId("editor.cover-add");

        // Add one through the palette.
        await openCoverPicker(s);
        await pickCoverImage(s, 0);
        await s.byTestId("editor.cover-banner");
        const firstSrc = await bannerSrc(s);
        await waitForSaved(s);

        // The banner precedes the Properties widget in the document. Asserted
        // through DOM order rather than pixels: the widget is what the banner
        // has to sit above, and `compareDocumentPosition` is the only claim a
        // headless run can honestly make about "above".
        const order = await s.execute<number>(
          `const b = document.querySelector('[data-testid="editor.cover-banner"]');
           const p = document.querySelector('.cm-fm-properties');
           if (!b || !p) return -1;
           return b.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : 0;`,
        );
        if (order !== 1) {
          throw new Error(`cover banner must precede the Properties widget (got ${order})`);
        }

        // The banner is the promoted surface, so the raw `cover:` row is NOT
        // repeated in the Properties widget, and the Add control withdraws.
        if ((await coverRowCount(s)) !== 0) {
          throw new Error("a valid cover must not also render as a property row");
        }
        await s.waitForGone(testIdSelector("editor.cover-add"));

        // Change: the hover control swaps the image in place, with no reopen.
        await pressBannerControl(s, "editor.cover-change");
        await s.byTestId("cover-picker.modal");
        await pickCoverImage(s, 1);
        await s.byTestId("editor.cover-banner");
        // In place: the banner is showing the NEW attachment, with no reopen
        // between. Asserting only that a banner exists would pass even if the
        // write had silently failed.
        await s.waitUntil(async () => (await bannerSrc(s)) !== firstSrc || null, {
          label: "cover banner repainted against the new attachment",
        });
        await waitForSaved(s);

        // Remove: the banner goes and the Add control comes back.
        await pressBannerControl(s, "editor.cover-remove");
        await s.waitForGone(testIdSelector("editor.cover-banner"));
        await s.byTestId("editor.cover-add");
        await waitForSaved(s);
      },
    );
  });
});

describeE2E("nco2 an empty attachment library offers nothing to pick (myne-md/myne#410)", () => {
  // Vault-count precondition: 1 (weak KDF). NO `exportSuite` here: the point is
  // a vault with no attachments at all.
  it("says the library is empty rather than showing an empty grid, and leaves the note coverless", async () => {
    let password = "";
    await scenario(
      "nco2-empty-attachment-library",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Kapaksız Not");

        await openCoverPicker(s);
        await s.byTestId("cover-picker.empty");
        // Esc rather than the close button: the shell's close control carries a
        // localized aria-label and no testid, and adding one purely for this
        // scenario would put a test hook in production DOM for a key the modal
        // already handles.
        //
        // Sent to the Upload BUTTON, not the modal container: a div is not
        // focusable and WebDriver refuses to type into it ("element not
        // interactable"). The toolbar renders even when the library is empty,
        // and the keydown bubbles to the same document handler either way.
        await (await s.byTestId("cover-picker.upload")).sendKeys(ESCAPE_KEY);
        await s.waitForGone(testIdSelector("cover-picker.modal"));

        // Nothing was written, so the note is still coverless and the way to
        // add one is still offered. A cancelled pick must not leave state.
        await s.waitForGone(testIdSelector("editor.cover-banner"));
        await s.byTestId("editor.cover-add");
      },
    );
  });
});

// NOT covered here, deliberately, and recorded rather than left to be noticed:
//
//   - **The dangling-cover case** (a valid `cover:` whose attachment is absent:
//     no banner, and the `cover:` row STAYS visible in the Properties widget so
//     the line is never invisible). Constructing it end to end needs either a
//     fixture that can seed arbitrary note plaintext — `seedVault` writes fixed
//     content — or driving the Properties widget's add-property flow through
//     two commit-on-blur inputs. It is covered at the unit level instead, in
//     `tests/editor/frontmatter-cover-row.test.ts` and
//     `tests/editor/cover-banner.test.ts`, both with injection checks. Worth
//     promoting here the next time the fixture generator grows an
//     arbitrary-note option.
//   - **The no-frontmatter note** (the palette path writes a fresh `---` block).
//     Same obstacle: reaching that state means deleting the frontmatter block,
//     which the Properties widget deliberately makes unreachable from the
//     editor surface.
