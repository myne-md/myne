// Note-cover lifecycle suite (myne-md/myne#410, e2e).
//
// Stories:
//   nco1 — a note with no cover gets one through the command palette → the
//          banner renders above the title → Change swaps it → Remove clears it
//          and the banner goes.
//   nco2 — a vault with no attachments: the picker says the library is empty
//          rather than showing an empty grid, and a cancelled pick leaves the
//          note coverless.
//   nco3 : in a SPLIT, Remove clears the cover of the pane whose banner was
//          pressed, and leaves the other pane's alone (myne-md/myne#520).
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
  clickNoteRow,
  pageSeatInvoke,
  rowMenuPick,
  runPaletteAction,
  selectedNoteId,
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
async function pressBannerControl(
  s: Session,
  controlTestId: string,
  // Which banner, when a split has drawn more than one. Index into DOM order,
  // so 0 is the left pane. Defaults to the only banner on screen.
  paneIndex = 0,
): Promise<void> {
  await s.waitUntil(
    async () => {
      // `hover()`, not a click: the controls only exist to the pointer while it
      // is over their host, and clicking the banner would be a real pointer
      // press inside the editor at position 0, moving focus and selection,
      // which is exactly what the production controls' mousedown+preventDefault
      // goes out of its way to avoid. In a split that avoidance is the bug's
      // cause rather than a detail: hovering does not focus the pane either, so
      // the shell never learns which note the press was about unless the banner
      // says (myne-md/myne#520).
      const banner = (await s.byTestIdAll("editor.cover-banner"))[paneIndex];
      if (banner === undefined) return null;
      await banner.hover();
      const control = (await s.byTestIdAll(controlTestId))[paneIndex];
      if (control === undefined) return null;
      await control.actionClick();
      return true;
    },
    { label: `banner control ${controlTestId} pressed on pane ${paneIndex}` },
  );
}

/** The banner image's current `src` (an `attachment://<id>` URL on desktop).
 *  Asserting the URL CHANGES is the difference between "a banner is there" and
 *  "the banner shows what was just picked". */
async function bannerSrc(s: Session, paneIndex = 0): Promise<string> {
  const img = await s.waitUntil(
    async () =>
      (await s.findElements(`${testIdSelector("editor.cover-banner")} img`))[paneIndex],
    { label: `cover banner image on pane ${paneIndex}` },
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

/**
 * Focus pane `index` by clicking in its editor content, the way a user does, and
 * wait for the shell to say so.
 *
 * Reading `data-focused` back is the point rather than politeness: the whole
 * scenario is about which pane the shell considers current, so a click that did
 * not land has to fail here rather than three steps later as a wrong cover.
 * A sidebar row click is NOT the same gesture: that opens the note in the
 * focused pane instead of moving focus to another one.
 */
async function focusPane(s: Session, index: number): Promise<void> {
  // WAIT for the frame, do not index into one snapshot. A split's second pane
  // mounts a beat after the workspace transition that created it, so the read
  // immediately after `rowMenuPick` comes back one element short and indexing
  // into it throws a `TypeError` that reads like a harness bug rather than a
  // race. Same reason `pickCoverImage` waits for its grid.
  const frame = await s.waitUntil(
    async () => (await s.byTestIdAll("editor.content-frame"))[index],
    { label: `editor content frame ${index}` },
  );
  await frame.click();
  await s.waitUntil(
    async () => {
      const panes = await s.byTestIdAll("editor.pane");
      return (await panes[index]?.attribute("data-focused")) === "true" || null;
    },
    { label: `pane ${index} focused` },
  );
}

/** Wait until exactly `n` cover banners are on screen. */
async function waitForBanners(s: Session, n: number): Promise<void> {
  await s.waitUntil(
    async () => (await s.byTestIdAll("editor.cover-banner")).length === n || null,
    { label: `${n} cover banner(s) on screen` },
  );
}

describeE2E("nco3 Remove acts on the pane whose banner was pressed (myne-md/myne#520)", () => {
  // Vault-count precondition: 1 (weak KDF), `exportSuite` for the image grid.
  //
  // The gesture is the whole test, so it is worth saying what it is: two notes
  // with DIFFERENT covers, side by side, focus the LEFT pane, then press Remove
  // on the RIGHT pane's banner without clicking into that pane first. Before the
  // fix the shell resolved the target from its own selected note, which the
  // banner's `preventDefault` had left pointing at the left pane, so the left
  // note lost its cover and the right one kept it.
  //
  // Two DIFFERENT images, and that is the discriminator rather than decoration:
  // "one banner left" is true both before and after the fix, so the assertion
  // has to be about WHICH one survived.
  it("clears the unfocused pane's cover and leaves the focused pane's alone", async () => {
    let password = "";
    await scenario(
      "nco3-split-remove-targets-its-own-pane",
      {
        seed: (dir) =>
          void (password = seedVault(dir, { exportSuite: true }).password),
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        // Ids read as each note is created, not by counting rows afterwards:
        // `exportSuite` seeds its own notes, so a row count is a fixture detail
        // rather than something this scenario controls.
        await createNote(s, "Sol Kapak");
        const left = await selectedNoteId(s);
        await createNote(s, "Sag Kapak");
        const right = await selectedNoteId(s);

        // Left pane: Sol Kapak, cover = the first image.
        await clickNoteRow(s, left);
        await openCoverPicker(s);
        await pickCoverImage(s, 0);
        await waitForBanners(s, 1);
        const leftSrc = await bannerSrc(s, 0);
        await waitForSaved(s);

        // Split: Sag Kapak to the side. The palette acts on the FOCUSED pane, so
        // focus the new one before giving it its own, different cover. (Whether
        // `open-to-side` focuses what it opened is not this scenario's subject,
        // and `focusPane` makes it not matter.)
        await rowMenuPick(s, right, "open-to-side");
        await focusPane(s, 1);
        await openCoverPicker(s);
        await pickCoverImage(s, 1);
        await waitForBanners(s, 2);
        const rightSrc = await bannerSrc(s, 1);
        if (rightSrc === leftSrc) {
          throw new Error(
            "the two panes must show DIFFERENT covers, or this scenario discriminates nothing",
          );
        }
        await waitForSaved(s);

        // Focus back to the LEFT pane. This is the state the bug needs: the
        // shell's selected note is Sol Kapak, and the control about to be pressed
        // belongs to Sag Kapak.
        await focusPane(s, 0);

        // Press Remove on the RIGHT pane's banner, with no click into that pane.
        // `pressBannerControl` hovers rather than clicks the banner, and the
        // control itself `preventDefault`s, so nothing here focuses pane 1, which
        // is exactly the production gesture and exactly the cause.
        await pressBannerControl(s, "editor.cover-remove", 1);

        // Assert on the FILES, not only on the DOM. The banner is a render of
        // `cover:`, and a render can lag a write or survive one; the bytes are
        // what the user keeps. Pre-fix these two swap: the left note is the one
        // that loses its cover.
        const body = async (id: string): Promise<string> => {
          const r = await pageSeatInvoke(s, "plugin:notes|note_read", { noteId: id }, 30_000);
          if (typeof r.ok !== "string") {
            throw new Error(`note_read(${id}) failed: ${JSON.stringify(r)}`);
          }
          return r.ok;
        };
        //
        // Watch BOTH notes and report which one lost its cover, rather than
        // waiting on the right one alone. Same information, far better failure:
        // waiting only on the right turns the pre-fix behaviour into a 45 s
        // timeout, which reads like a broken scenario. This names it.
        const cleared = await s.waitUntil(
          async () => {
            // SEQUENTIAL, never `Promise.all`: `pageSeatInvoke` parks its
            // result on the single `window.__e2eIpc` slot and clears that slot
            // before each call, so two in flight overwrite each other and the
            // loop either reads the wrong note or waits for a result that was
            // already wiped. It cost a 180 s test timeout to find.
            const l = await body(left);
            const r = await body(right);
            if (!l.includes("cover:")) return "left";
            if (!r.includes("cover:")) return "right";
            return null;
          },
          { label: "one of the two notes losing its cover: on disk" },
        );
        if (cleared !== "right") {
          throw new Error(
            "Remove cleared the wrong note: the LEFT pane's note lost its cover " +
              "while the pressed banner belonged to the right pane. That is " +
              "myne-md/myne#520 exactly.",
          );
        }

        // And the render agrees: one banner, the left pane's, and the right pane
        // offering Add cover again.
        await waitForBanners(s, 1);
        const survivor = await bannerSrc(s, 0);
        if (survivor !== leftSrc) {
          throw new Error(
            `the surviving banner is not the left pane's: expected ${leftSrc}, got ${survivor}`,
          );
        }
        await s.waitUntil(
          async () => (await s.byTestIdAll("editor.cover-add")).length === 1 || null,
          { label: "the right pane offering Add cover again" },
        );
        await waitForSaved(s);
      },
    );
  });
});

// NOT covered here, deliberately, and recorded rather than left to be noticed:
//
//   - **The autosave race**, the other half of myne-md/myne#520: type into a
//     covered note and remove the cover from the palette INSIDE the 1 s autosave
//     idle debounce. Not driver-reachable, and the reason is arithmetic rather
//     than effort: opening the palette, typing the query and pressing Enter is
//     several WebDriver round trips, every one of which outlasts the debounce,
//     so the autosave has always fired by the time the write starts. Covered at
//     the unit level instead, in `tests/notes/frontmatterFlushOrdering.test.ts`,
//     which asserts the ordering over all three writers of that class and was
//     verified by injecting a missing flush, an unawaited one and a swallowed
//     failure.
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
