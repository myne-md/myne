// Flow-logic: photo to note (myne-md/myne#926). Headless Chromium against the
// dev server with mock IPC, NOT an end-to-end suite, and the distinction
// matters here more than usual: the one thing this feature exists to read (a
// camera's photograph of a page) cannot be produced by any lane in this
// repository, so the OS picker and the OCR result are both mocked and the
// roster's `editor.photo-to-note` item owns what only a handset can answer.
//
// What this file DOES pin is the flow's data discipline, which is the half a
// mock can hold honestly:
//
//   • the entry reaches the draft sheet instead of dropping a bare embed, and
//     the field is seeded with the cached reading;
//   • an edit committed from the sheet is what lands, under the image embed, in
//     one block: the note body is read back from the live editor, and the write
//     that reaches the durable path carries the same bytes;
//   • a CANCEL writes nothing at all and deletes exactly the attachment this
//     flow imported, so an abandoned draft leaves no orphan in the library and
//     no paragraph in the note.
//
// The last one is why this scenario exists rather than a unit test alone: "the
// surface does not write behind the user" is the promise of the whole flow, and
// the `editor-no-silent-write` file is the precedent for asserting it where the
// user's own action is in the middle.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "./mock-ipc";

/** The id the mock's `attachment_import` always returns. */
const ID = "a".repeat(64);

const NOTE = {
  id: "n1",
  text: "---\ntitle: Alpha\nupdated: 2026-07-01T10:00:00.000Z\n---\n\nalpha body line\n",
};

/** What the page "contained". One Turkish line and one with digits, because a
 *  reading that lost its numerals is the usual failure and a URL-ish line makes
 *  an accidental markdown interpretation visible. */
const PHOTO_TEXT = "Toplantı notları\nyarın saat 14:00";

async function readNoteUpdates(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __noteUpdates?: string[] }).__noteUpdates ?? [],
  );
}

async function readDeletes(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __attachmentDeletes?: string[] }).__attachmentDeletes ?? [],
  );
}

async function firePagehide(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
}

async function bootAndOpenNote(
  page: Page,
  config: {
    readExtractedText?: Record<string, string | null>;
    prefs?: Record<string, unknown>;
    importDeduplicated?: boolean;
    deleteFails?: boolean;
    createNoteFails?: boolean;
  } = {},
): Promise<void> {
  await installMockIpc(page, {
    notes: [NOTE],
    readExtractedText: config.readExtractedText ?? { [ID]: PHOTO_TEXT },
    prefs: config.prefs,
    importDeduplicated: config.importDeduplicated,
    deleteFails: config.deleteFails,
    createNoteFails: config.createNoteFails,
  });
  await page.goto("/");
  await expect(page.getByTestId("workspace.app-header")).toBeVisible();
  await page.locator('[data-testid="notes.row"][data-note-id="n1"]').click();
  await expect(page.getByTestId("editor.top-bar")).toBeVisible();
}

/** Hand the hidden input a file, which is what the OS picker does on a device.
 *  Going through `setInputFiles` rather than clicking the entry keeps the test
 *  off the native dialog; the entry's own button is asserted in each case. */
async function pickPhoto(page: Page): Promise<void> {
  await page.locator('[data-testid="editor.photo-input"]').setInputFiles({
    name: "page.png",
    mimeType: "image/png",
    // A real PNG signature is not needed: the mock import never sniffs bytes.
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });
}

test.describe("photo to note", () => {
  test("the entry button opens the picker, and the photograph shows while it imports", async ({ page }) => {
    await bootAndOpenNote(page);
    // The button, not the hidden input: emptying `onPhotoToNote` used to leave
    // all six cases green, which is a dead feature shipping behind a green tier.
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("editor.photo-to-note").click();
    const fileChooser = await chooser;
    await fileChooser.setFiles({
      name: "page.png",
      mimeType: "image/png",
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });

    // Both phases are observable: the sheet opens on the picked FILE (importing,
    // because the import runs OCR and can take seconds), then the id arrives.
    await expect(page.getByTestId("photo-note.sheet")).toBeVisible();
    await expect(page.getByTestId("photo-note.preview")).toBeAttached();
    await expect
      .poll(async () => page.getByTestId("photo-note.sheet").getAttribute("data-phase"))
      .toBe("ready");
  });

  test("a cancel of a deduplicated import deletes nothing", async ({ page }) => {
    // `attachment_import` is content-addressed: picking an image the vault
    // already holds returns the EXISTING entry with `deduplicated: true`. The
    // first cancel implementation deleted by id and would have destroyed a
    // synced attachment the user already had, breaking every note embedding it.
    await bootAndOpenNote(page, { importDeduplicated: true });
    await pickPhoto(page);
    await expect(page.getByTestId("photo-note.text")).toHaveValue(PHOTO_TEXT);

    await page.getByTestId("photo-note.cancel").click();
    await expect(page.getByTestId("photo-note.sheet")).toHaveCount(0);

    const deletes = await page.evaluate(
      () => (window as unknown as { __attachmentDeletes?: string[] }).__attachmentDeletes ?? [],
    );
    expect(deletes).toEqual([]);
    await firePagehide(page);
    await page.waitForTimeout(300);
    expect(await readNoteUpdates(page)).toHaveLength(0);
  });

  test("a cancel that cannot delete says so instead of closing quietly", async ({ page }) => {
    await bootAndOpenNote(page, { deleteFails: true });
    await pickPhoto(page);
    await expect(page.getByTestId("photo-note.text")).toHaveValue(PHOTO_TEXT);

    await page.getByTestId("photo-note.cancel").click();

    // The sheet still closes (the draft is abandoned either way), but the user
    // is told the bytes are still there rather than being told nothing.
    await expect(
      page.getByText("The photo could not be removed. It is still in your attachments."),
    ).toBeVisible();
  });

  test("the entry opens a draft, and the edited text lands under the image", async ({ page }) => {
    await bootAndOpenNote(page);
    await expect(page.getByTestId("editor.photo-to-note")).toBeVisible();

    await pickPhoto(page);

    // The draft opens ON the note rather than inserting an embed immediately.
    await expect(page.getByTestId("photo-note.sheet")).toBeVisible();
    // ATTACHED, not VISIBLE: this tier's `convertFileSrc` returns a fake
    // `attachment://` URL that no server answers, so the <img> has no intrinsic
    // size and a visibility assertion would be testing the mock's 404. What the
    // flow owes is that the photograph is in the sheet at all; whether a real
    // served blob paints is the device item on the roster.
    await expect(page.getByTestId("photo-note.preview")).toBeAttached();
    await expect(page.getByTestId("photo-note.text")).toHaveValue(PHOTO_TEXT);

    // Correct it, as the sheet expects the user to.
    await page.getByTestId("photo-note.text").fill("Toplantı notları\nyarın saat 14:30");
    await page.getByTestId("photo-note.commit").click();

    await expect(page.getByTestId("photo-note.sheet")).toHaveCount(0);

    // Read the DURABLE bytes rather than the rendered body: the live preview
    // paints the embed as a file card, so `innerText` shows "page.png" and not
    // the wikilink. The source is what a reader of the note gets.
    await firePagehide(page);
    await expect.poll(() => readNoteUpdates(page)).toHaveLength(1);
    const [update] = await readNoteUpdates(page);
    expect(update).toContain(`![[att:${ID}|page.png]]`);
    expect(update).toContain("yarın saat 14:30");
    // The cached reading is NOT what landed: the sheet exists so the
    // correction is the thing written.
    expect(update).not.toContain("14:00");
  });

  test("the block is one insertion, image first and text directly below", async ({ page }) => {
    await bootAndOpenNote(page);
    await pickPhoto(page);
    await expect(page.getByTestId("photo-note.text")).toHaveValue(PHOTO_TEXT);

    await page.getByTestId("photo-note.commit").click();
    await expect(page.getByTestId("photo-note.sheet")).toHaveCount(0);

    await firePagehide(page);
    await expect.poll(() => readNoteUpdates(page)).toHaveLength(1);
    const [update] = await readNoteUpdates(page);
    const embedAt = update.indexOf(`![[att:${ID}`);
    const textAt = update.indexOf("Toplantı notları");
    expect(embedAt).toBeGreaterThanOrEqual(0);
    expect(textAt).toBeGreaterThan(embedAt);
    // Directly below: one blank line, no heading and no wrapper invented
    // between the image and its reading.
    expect(update.slice(embedAt)).toMatch(new RegExp(`^!\\[\\[att:${ID}\\|page\\.png\\]\\]\\n\\nToplantı`));
  });

  test("a cancel writes nothing and deletes only this flow's import", async ({ page }) => {
    await bootAndOpenNote(page);
    await pickPhoto(page);
    await expect(page.getByTestId("photo-note.sheet")).toBeVisible();

    await page.getByTestId("photo-note.cancel").click();
    await expect(page.getByTestId("photo-note.sheet")).toHaveCount(0);

    await expect.poll(() => readDeletes(page)).toEqual([ID]);

    // Nothing was typed into the note and the flush must not claim otherwise.
    await firePagehide(page);
    await page.waitForTimeout(300);
    expect(await readNoteUpdates(page)).toHaveLength(0);
    const body = await page.locator(".cm-content").innerText();
    expect(body).not.toContain("att:");
    expect(body).not.toContain("page.png");
  });

  test("the new-note destination creates a titled note holding the block", async ({ page }) => {
    await bootAndOpenNote(page);
    await pickPhoto(page);
    await expect(page.getByTestId("photo-note.text")).toHaveValue(PHOTO_TEXT);

    await page.getByTestId("photo-note.destination-1").click();
    await page.getByTestId("photo-note.commit").click();
    await expect(page.getByTestId("photo-note.sheet")).toHaveCount(0);

    // A new note, not the open one: the payload is the created body, and the
    // title comes from the CORRECTED first line (the reading is the same here,
    // which is why the assertion names the line rather than the raw field).
    const creates = await page.evaluate(
      () => (window as unknown as { __noteCreates?: string[] }).__noteCreates ?? [],
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain(`![[att:${ID}|page.png]]`);
    expect(creates[0]).toContain("title: Toplantı notları");
    // And nothing was appended to the note that was open.
    await firePagehide(page);
    await page.waitForTimeout(300);
    expect(await readNoteUpdates(page)).toHaveLength(0);
  });

  test("the new-note destination files it where the user's preference says", async ({ page }) => {
    // Task 5's criterion, and the arm that used to be a lie: `noteCreate`'s
    // folder argument registers a folder, it does not place the note, so without
    // the `folder:` patch every capture landed at the vault root.
    await bootAndOpenNote(page, {
      prefs: { new_note_location: "specific", new_note_location_folder: "Projeler/" },
    });
    await pickPhoto(page);
    await expect(page.getByTestId("photo-note.text")).toHaveValue(PHOTO_TEXT);

    await page.getByTestId("photo-note.destination-1").click();
    await page.getByTestId("photo-note.commit").click();
    await expect(page.getByTestId("photo-note.sheet")).toHaveCount(0);

    const creates = await page.evaluate(
      () => (window as unknown as { __noteCreates?: string[] }).__noteCreates ?? [],
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain("folder: Projeler/");
  });

  test("a failed create keeps the sheet and the user's text", async ({ page }) => {
    await bootAndOpenNote(page, { createNoteFails: true });
    await pickPhoto(page);
    await expect(page.getByTestId("photo-note.text")).toHaveValue(PHOTO_TEXT);

    await page.getByTestId("photo-note.destination-1").click();
    await page.getByTestId("photo-note.commit").click();

    // The sheet stays: retapping the button is the retry, and the text is still
    // in the field. A dismissed sheet plus an error would read as a lost capture.
    await expect(page.getByTestId("photo-note.sheet")).toBeVisible();
    await expect(page.getByTestId("photo-note.text")).toHaveValue(PHOTO_TEXT);
    await expect(
      page.getByText("The note could not be created. Your text is still here."),
    ).toBeVisible();
  });

  test("with text reading off, the sheet says so and still adds the image", async ({ page }) => {
    await bootAndOpenNote(page, { prefs: { attachment_ocr_enabled: false } });
    await pickPhoto(page);

    await expect(page.getByTestId("photo-note.ocr-off")).toBeVisible();
    await expect(page.getByTestId("photo-note.reading")).toHaveCount(0);

    await page.getByTestId("photo-note.commit").click();
    await expect(page.getByTestId("photo-note.sheet")).toHaveCount(0);

    await firePagehide(page);
    await expect.poll(() => readNoteUpdates(page)).toHaveLength(1);
    expect((await readNoteUpdates(page))[0]).toContain(`![[att:${ID}|page.png]]`);
  });

  test("a page the extractor read nothing from still offers the image", async ({ page }) => {
    await bootAndOpenNote(page, { readExtractedText: { [ID]: null } });
    await pickPhoto(page);

    await expect(page.getByTestId("photo-note.empty")).toBeVisible();

    await page.getByTestId("photo-note.commit").click();
    await expect(page.getByTestId("photo-note.sheet")).toHaveCount(0);

    await firePagehide(page);
    await expect.poll(() => readNoteUpdates(page)).toHaveLength(1);
    const [update] = await readNoteUpdates(page);
    expect(update).toContain(`![[att:${ID}|page.png]]`);
    // Image only: no empty paragraph and no placeholder sentence was invented
    // to stand in for the text nobody found.
    expect(update).not.toContain("No text");
  });
});
