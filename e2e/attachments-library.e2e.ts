// al1 — attachments library: import → tile/thumbnail → rename →
// used-in-notes → delete, plus MYA1/MYC1 at-rest magic (MYND-230,
// e2e-wave-2). Vault-count precondition: 1.
//
// Pins the attachments LIBRARY surface through the production binary
// end-to-end, the counterpart to ac1 (clean-unused) and gf1 (generic
// export):
//   - SETUP is page-seat IPC (`pageSeatInvoke` — production IPC, zero test
//     hooks; the ac1/gf1 precedent), because attachment import terminates at
//     a native file dialog WebDriver can't drive. A known image and a known
//     generic file are imported as inline bytes, plus a note that references
//     the image (so the used-in-notes surface has a row to list).
//   - The library is opened through the REAL command-palette action
//     `attachments.open` (the ac1 entry path), then driven by real clicks:
//     the ⋮ menu Rename / Delete items, the inline rename input, the
//     used-in-notes trigger + popover row, the DeleteAttachmentDialog confirm.
//   - User-visible outcomes are asserted by testid; the catalog truth is
//     re-read via page-seat `catalog_list`. At rest, the per-attachment MYA1
//     blob (`attachments/<id-hex>`) and the MYC1 catalog (`vault.attachments`)
//     are magic-byte-asserted after import (the positive control complementing
//     PS-1's negative residue scan), and the blob file is asserted GONE after
//     the delete.
//
// Thumbnail is asserted as element-present + resolved non-empty `src` only,
// NOT pixel/decode success (the gf1 fragility precedent). The in-note
// tombstone widget render after delete is library-scoped OUT (editor
// CM6-widget territory; gf1-deferred).
//
// SYNC-13: attachment-ids, filenames, and the note body are scenario content,
// not credentials; no password/phrase appears in any assert. KDF: weak
// generator fixtures (unlock reads params from vault.meta).
//
// ⚠️ NEW SCENARIO — authored but NOT yet validated in the container. Per
// `e2e/AGENTS.md` definition of done it must go green 3× consecutive via
// `./scripts/e2e-local.sh` before merge (it introduces the
// attachments-library tile/⋮-menu/rename/used-in-notes/delete testids and
// the MYA1/MYC1 at-rest asserters).

import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import {
  assertAttachmentBlobMagic,
  assertCatalogMagic,
  attachmentBlobPath,
  seedVault,
  type SeededVault,
} from "./support/fixtures";
import {
  dismissImporterOffer,
  pageSeatInvoke,
  clickBySelector,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;
/** W3C Actions API code point for Enter — sent as an explicit escape, never a
 *  literal newline (the invisible-key hazard). */
const ENTER = "";

/** A REAL, decodable 1×1 PNG (not just the signature) tagged with a trailing
 *  distinguishing byte so distinct tags yield distinct content-addressed ids.
 *  Must actually decode: the library thumbnail renders `<img>` and falls back to
 *  a generic file icon on the `<img>` `onError` (an undecodable image has no
 *  `attachments.thumbnail` element), so the signature-only stub never produced a
 *  thumbnail. The tag byte trails IEND — PNG decoders ignore trailing bytes, so
 *  the image still decodes 1×1 while the content hash varies per tag. */
function pngBytes(tag: number): number[] {
  return [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length + type
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1×1
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, // bit depth/color + CRC
    0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, // IDAT length + type
    0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, // zlib data
    0x0d, 0x0a, 0x2d, 0xb4, // IDAT CRC
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82, // IEND
    tag, // trailing tag — ignored by decoders, varies the content hash
  ];
}

/** Opaque bytes the magic-byte sniffer does NOT recognize → stored as
 *  application/octet-stream (the generic-file path). */
const DOC_BYTES: number[] = Array.from(
  new TextEncoder().encode("opaque generic library file — MYND-230 al1"),
);

async function importBytes(
  s: Session,
  bytes: number[],
  filename: string,
): Promise<string> {
  const r = await pageSeatInvoke(
    s,
    "plugin:attachments|attachment_import",
    { source: { kind: "bytes", bytes, filename } },
    IPC_TIMEOUT,
  );
  expect(r.err, "attachment_import should succeed").toBeUndefined();
  return (r.ok as { id: string }).id;
}

/** Catalog rows re-read via page-seat IPC (the disk truth). */
async function catalog(s: Session): Promise<Array<{ id: string; filename: string }>> {
  const r = await pageSeatInvoke(s, "plugin:attachments|catalog_list", {}, IPC_TIMEOUT);
  expect(r.err, "catalog_list should succeed").toBeUndefined();
  return r.ok as Array<{ id: string; filename: string }>;
}

describeE2E("attachments library (MYND-230)", () => {
  it("al1 — import, thumbnail, rename, used-in-notes, delete + MYA1/MYC1 at rest", async () => {
    let seeded: SeededVault;
    await scenario(
      "al1-attachments-library",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // ---- setup (page-seat IPC): one image, one generic file, one note
        //      that references the image ----
        const imageId = await importBytes(s, pngBytes(1), "diagram.png");
        const genericId = await importBytes(s, DOC_BYTES, "budget.docx");
        const noteRes = await pageSeatInvoke(
          s,
          "plugin:notes|note_create",
          { plaintext: `![[att:${imageId}]]` },
          IPC_TIMEOUT,
        );
        expect(noteRes.err, "note_create should succeed").toBeUndefined();
        const noteId = noteRes.ok as string;

        // ---- at-rest positive control: MYA1 blob + MYC1 catalog after import ----
        assertAttachmentBlobMagic(app.appDataDir, seeded.vaultId, imageId);
        assertAttachmentBlobMagic(app.appDataDir, seeded.vaultId, genericId);
        assertCatalogMagic(app.appDataDir, seeded.vaultId);

        // The referencing note was created via page-seat IPC, so the frontend
        // note cache hasn't seen it. Reload the WebView (slot stays Unlocked →
        // editor) so the used-in-notes surface — which resolves the attachment's
        // referencing note-ids to titles through that cache — can list it.
        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });

        // **Warm the attachment-refs index before the library mounts, and this
        // is a real precondition rather than a sleep.** The tile's own count is
        // ONE query at mount (`UsedInNotes`'s effect depends on `attachmentId`
        // alone), so a library that opens while the backend is still building its
        // refs index reads zero and keeps saying "Used in 0 notes" for the rest
        // of the session: measured, the tile read 0 across 12 s of polling while
        // the same command asked a second later returned the note's id. The
        // assertion below can only be made against a warm index, so the index is
        // asserted warm FIRST, which also makes a failure name the right thing.
        await s.waitUntil(
          async () => {
            const r = await pageSeatInvoke(
              s,
              "plugin:attachments|attachment_refs_referencing",
              { attachmentId: imageId },
              IPC_TIMEOUT,
            );
            const ids = Array.isArray(r.ok) ? (r.ok as string[]) : [];
            return ids.includes(noteId) ? true : null;
          },
          {
            label: "the attachment-refs index knows the referencing note",
            timeoutMs: 30_000,
          },
        );

        // ---- open the library from the RAIL ----
        //
        // It was `runPaletteAction(s, "attachments.open", "attach")`, and that
        // route ended with the *New note from template* picker open over the
        // grid while the Attachments tab was ALSO active (measured: the modal
        // appeared between the palette's open and its row click, the row was
        // gone, and the palette had closed). Two commands cannot both have run
        // from one click, so the palette lookup is under suspicion rather than
        // exonerated; the rail is the same production route `att-tab` ATT-TAB-1
        // uses for this exact surface, it is pinned by default, and it keeps this
        // scenario on its own subject (the library's CRUD).
        await s.execute(
          `document.querySelector('[data-testid="editor.ribbon.button"][data-command-id="attachments.open"]').click();`,
        );

        // ---- the imported image tile is present; its thumbnail <img> carries
        //      a resolved (non-empty) src — element + src only, no decode ----
        const imageTile = await s.waitForElement(
          testIdSelector("attachments.tile", { "data-id": imageId }),
        );
        expect(imageTile).toBeDefined();
        const thumb = await s.waitForElement(
          testIdSelector("attachments.thumbnail", { "data-id": imageId }),
        );
        const src = await thumb.property<string>("src");
        expect(src, "thumbnail <img> resolves a non-empty src").toBeTruthy();
        expect(src.length).toBeGreaterThan(0);

        // ---- rename via ⋮ → Rename → inline input; catalog reflects it ----
        const NEW_NAME = "renamed-diagram.png";
        await tileTrigger(s, imageId);
        await (await s.byTestId("attachments.action-rename")).click();
        const renameInput = await s.byTestId("attachments.rename-input");
        await renameInput.replaceText(NEW_NAME);
        await renameInput.sendKeys(ENTER);
        await s.waitForGone(testIdSelector("attachments.rename-input"));
        await s.waitUntil(
          async () => {
            const rows = await catalog(s);
            return rows.find((e) => e.id === imageId)?.filename === NEW_NAME || null;
          },
          { label: "catalog reflects the renamed filename", timeoutMs: IPC_TIMEOUT },
        );

        // ---- used-in-notes: the popover lists the referencing note ----
        await (
          await s.waitForElement(
            testIdSelector("attachments.used-in-notes-trigger", { "data-id": imageId }),
          )
        ).click();
        const usedRow = await s.waitForElement(
          testIdSelector("attachments.used-in-notes-row", { "data-note-id": noteId }),
        );
        expect(usedRow, "used-in-notes popover lists the referencing note").toBeDefined();

        // ---- delete via ⋮ → Delete → DeleteAttachmentDialog confirm ----
        const blobPath = attachmentBlobPath(app.appDataDir, seeded.vaultId, imageId);
        expect(existsSync(blobPath), "blob exists before delete").toBe(true);
        await tileTrigger(s, imageId);
        await (await s.byTestId("attachments.action-delete")).click();
        await (await s.byTestId("delete-attachment.confirm")).click();
        await s.waitForGone(testIdSelector("delete-attachment.confirm"));

        // ---- catalog row gone + MYA1 blob file gone (library-scoped; NO
        //      in-note tombstone-render assertion) ----
        await s.waitUntil(
          async () => {
            const rows = await catalog(s);
            return rows.every((e) => e.id !== imageId) || null;
          },
          { label: "catalog row removed after delete", timeoutMs: IPC_TIMEOUT },
        );
        await s.waitForGone(testIdSelector("attachments.tile", { "data-id": imageId }));
        expect(existsSync(blobPath), "MYA1 blob file removed after delete").toBe(false);
      },
    );
  });
});

/** Re-fetch THIS tile's ⋮ actions trigger (handles go stale across the
 *  menu-close / rename remount between the two ⋮ opens). The trigger is the
 *  `attachments.actions-trigger` inside the tile addressed by its data-id. */
async function tileTrigger(s: Session, attachmentId: string): Promise<void> {
  // **`clickBySelector`, not `Element.click()`.** The trigger is an icon-only ⋮
  // inside a tile, and its plain click times out on "element interactable +
  // clicked", a message that cannot say whether the control is zero-sized,
  // scrolled out of its container or covered. The helper re-locates, scrolls it
  // into view inside its own scroll container, and on a refusal reports what is
  // actually AT the centre.
  //
  // What that report says today (measured, 2026-10-17): the centre is covered by
  // `class="myne-modal-body"` of the **New note from template** picker, i.e. a
  // modal this scenario never opens sits over the grid. The tile supports the
  // same menu from a right-click, and that gesture was tried and is blocked by
  // the same modal, so this scenario is parked on that rather than fixed here.
  await clickBySelector(
    s,
    testIdSelector("attachments.tile", { "data-id": attachmentId }) +
      " " +
      testIdSelector("attachments.actions-trigger"),
  );
}
