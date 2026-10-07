// eo1: overflow-menu parity on an inline image embed (myne-md/myne#409).
//
// Before this, `AttachmentImageWidget` and `AttachmentPdfWidget` built no
// overflow menu, so an embedded image could not be renamed, exported, removed
// or revealed while the generic file card, the audio player and the text
// preview all could. This drives the production bundle: import a real image,
// embed it, open the "⋯", rename through the in-WebView prompt, and assert the
// widget re-renders under the new name.
//
// It reuses the `attachment-zoom` (za1) approach, which established that the
// inline image widget IS reachable through real UI: the image genuinely
// decrypts and decodes in WebKit, so the widget renders against real bytes
// rather than erroring to a fallback chip. It also reuses the same fixture PNG
// (one binary, three consumers now).
//
// Rename is the row asserted end-to-end because it is the only one of the four
// whose effect is visible in the editor without a native dialog: Export and
// Reveal open a native save dialog / navigate to the library, and Remove is
// already covered for the file card. `attachment_rename` goes through the real
// capability ACL, and the widget re-render on the catalog update is the proof.
//
// The PDF widget's menu is pinned in the Vitest-DOM layer
// (`tests/editor/embed-overflow-menu.test.tsx`) rather than here: there is no
// importable PDF fixture in the tree, and hand-rolling one would make this
// scenario's outcome depend on whether the magic-byte sniffer and pdf.js both
// accept it in the container. The widget contract is identical for both.
//
// Vault-count precondition: 1 (weak KDF). The fixture image + filenames are
// in-source scenario content, not credentials (SYNC-13).
//
// Certified green 3× consecutive in the container on 2026-08-15
// (`./scripts/e2e-buildrun.sh embed-overflow-menu`, then two `e2e-one.sh` runs
// against the same binary), per e2e/AGENTS.md "definition of done".

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickByTestId,
  createNote,
  dismissImporterOffer,
  pageSeatInvoke,
  seedEmbedIntoNote,
  unlockToEditor,
  waitForInlineImage,
} from "./support/flows";
import { REPO_ROOT } from "./support/session";
import { testIdSelector, type Session } from "./support/webdriver";

const FILENAME = "diagram.png";
const RENAMED = "renamed-diagram.png";
const IPC_TIMEOUT = 60_000;

function fixturePng(): number[] {
  return Array.from(
    readFileSync(join(REPO_ROOT, "core", "tests", "fixtures", "ocr-sample.png")),
  );
}

async function importImage(s: Session): Promise<string> {
  const r = await pageSeatInvoke(
    s,
    "plugin:attachments|attachment_import",
    { source: { kind: "bytes", bytes: fixturePng(), filename: FILENAME } },
    IPC_TIMEOUT,
  );
  expect(r.err, "attachment_import should accept the .png file").toBeUndefined();
  return (r.ok as { id: string }).id;
}


/** The embed frame's inline width, which the layout segment drives. */
async function frameWidth(s: Session): Promise<string> {
  return s.execute<string>(
    `const i = document.querySelector('[data-testid="attachment-image"]');
     const f = i && i.closest('.cm-attachment-frame');
     return f ? f.style.width || '' : '';`,
  );
}

/** Whether the frame carries an alignment class. */
async function frameAligned(s: Session, align: string): Promise<boolean> {
  return s.execute<boolean>(
    `const i = document.querySelector('[data-testid="attachment-image"]');
     const f = i && i.closest('.cm-attachment-frame');
     return !!f && f.classList.contains('cm-attachment-frame-align-${align}');`,
  );
}

/** Open the embed's overflow menu and wait for the body-mounted list. */
async function openEmbedMenu(s: Session): Promise<void> {
  // Re-click until the menu is actually up, the same shape `clickNewItem`
  // uses and for the same recorded reason: a wait with nothing to re-fire spends
  // its whole budget and reports a timeout that reads like a dead surface. Here
  // it read as `attachment-image.menu` never existing while its button was
  // clicked, which is a click that missed rather than a menu that never renders.
  // `clickByTestId` hit-tests and scrolls the control into its own container
  // first, which a raw `.click()` does not.
  await s.waitUntil(
    async () => {
      if ((await s.byTestIdAll("attachment-image.menu")).length > 0) return true;
      await clickByTestId(s, "attachment-image.menu-button", { timeoutMs: 10_000 });
      return (await s.byTestIdAll("attachment-image.menu")).length > 0 ? true : null;
    },
    { label: "the embed overflow menu is open", timeoutMs: 30_000 },
  );
}

/** The embed's accessible name, which tracks the catalog filename.
 *
 *  Read off the IMAGE, not the frame. ARIA gives a `role="img"` element
 *  presentational children, so naming the frame would take the overflow menu
 *  and the unreadable-segment marker inside it out of the accessibility tree. */
async function frameLabel(s: Session): Promise<string> {
  return s.execute<string>(
    `const i = document.querySelector('[data-testid="attachment-image"]');
     return i ? i.getAttribute('alt') || '' : '';`,
  );
}

describeE2E("eo1 embed overflow menu on an image embed (myne#409)", () => {
  it("opens the ⋯ menu, offers the four file actions, and renames through it", async () => {
    let password = "";
    await scenario(
      "eo1-embed-overflow-menu",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        const attachmentId = await importImage(s);
        await createNote(s, "Diagram note");
        // No `waitForSaved` after this: the write went through `note_update`,
        // not through the editor, so the autosave badge never leaves its
        // pre-edit state and the wait burns its whole budget before failing.
        // The IPC call is already durable when it returns.
        await seedEmbedIntoNote(s, `![[att:${attachmentId}|${FILENAME}]]`);

        // Wait until the inline image has decoded, so the widget is rendering
        // against real bytes rather than its error fallback.
        await waitForInlineImage(s, attachmentId);

        // Read the stored name off the widget rather than assuming the one we
        // imported. `Compress images on import` is ON by default and re-encodes
        // a PNG to WebP, so the catalog filename is `diagram.webp`, not
        // `diagram.png`. Asserting the input name here failed three times in
        // the container for exactly that reason, which is the whole point of
        // running it. What this scenario is about is that the rename CHANGES
        // the name, so bind to the observed baseline and stay independent of
        // the compression preference.
        const storedName = await frameLabel(s);
        expect(storedName, "the embed should render under its catalog name").not.toBe("");
        expect(storedName).not.toBe(RENAMED);

        // The "⋯" exists on the embed and opens the body-mounted menu.
        await openEmbedMenu(s);

        // All four file actions are offered, at parity with the file card.
        for (const row of ["export", "rename", "remove", "reveal"]) {
          await s.byTestId(`attachment-image.${row}`);
        }

        // Rename through the menu: the in-WebView prompt (the Tauri WebView
        // no-ops window.prompt, hence the custom dialog) drives the real
        // `attachment_rename` command through the capability ACL.
        await (await s.byTestId("attachment-image.rename")).click();
        const input = await s.waitForElement(testIdSelector("attachment-rename.input"));
        await input.clear();
        await input.sendKeys(RENAMED);
        await (await s.byTestId("attachment-rename.confirm")).click();

        // The catalog update re-renders the widget under the new name.
        await s.waitUntil(
          async () => ((await frameLabel(s)) === RENAMED ? true : null),
          { label: "embed re-renders under the renamed attachment", timeoutMs: 15_000 },
        );

        // Still one rendered embed, still decoded: the rename re-rendered the
        // widget rather than replacing it with a tombstone.
        expect(
          await s.execute<boolean>(
            `const i = document.querySelector('[data-testid="attachment-image"]'); return !!i && i.offsetWidth > 0;`,
          ),
        ).toBe(true);
      },
    );
  });
});

describeE2E("eo2 embed layout rows write into the note (myne#409)", () => {
  it("sets a size and an alignment through the menu, and shows them back as checked", async () => {
    let password = "";
    await scenario(
      "eo2-embed-layout-rows",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        const attachmentId = await importImage(s);
        await createNote(s, "Layout note");
        // No `waitForSaved` after this: the write went through `note_update`,
        // not through the editor, so the autosave badge never leaves its
        // pre-edit state and the wait burns its whole budget before failing.
        // The IPC call is already durable when it returns.
        await seedEmbedIntoNote(s, `![[att:${attachmentId}|${FILENAME}]]`);

        await waitForInlineImage(s, attachmentId);

        // Pick a size preset. The note bytes are the assertion: this is the
        // only authoring path for a layout segment, because a form-C embed is
        // atomic and the caret cannot enter it to type one.
        await openEmbedMenu(s);
        await (await s.byTestId("attachment-image.size-small")).click();
        await s.waitUntil(
          async () => ((await frameWidth(s)) === "240px" ? true : null),
          { label: "the size preset reaches the note and re-renders", timeoutMs: 10_000 },
        );

        // Then an alignment, which must ADD to the width rather than replace it.
        await openEmbedMenu(s);
        await (await s.byTestId("attachment-image.align-center")).click();
        await s.waitUntil(
          async () => ((await frameAligned(s, "center")) ? true : null),
          { label: "the alignment reaches the note and re-renders", timeoutMs: 10_000 },
        );
        // Both, so the second write ADDED to the first rather than replacing it.
        expect(await frameWidth(s)).toBe("240px");
        expect(await frameAligned(s, "center")).toBe(true);

        // Re-opening the menu shows both choices back. This is the note-bytes
        // assertion in the only form the UI exposes: a row is checked because
        // the parser read `w=240` and `align=center` back OUT of the document,
        // so a tick here means the segments really landed in the note. The menu
        // is also the only place the current size is visible, so a stale tick
        // would leave the author with no way to see what is set.
        await openEmbedMenu(s);
        expect(
          await (await s.byTestId("attachment-image.size-small")).attribute("aria-checked"),
        ).toBe("true");
        expect(
          await (await s.byTestId("attachment-image.align-center")).attribute("aria-checked"),
        ).toBe("true");
        expect(
          await (await s.byTestId("attachment-image.size-large")).attribute("aria-checked"),
        ).toBe("false");

        // Selecting the active preset again clears it: the width goes, the
        // alignment stays.
        await (await s.byTestId("attachment-image.size-small")).click();
        await s.waitUntil(
          async () => ((await frameWidth(s)) === "" ? true : null),
          { label: "re-selecting the active preset clears the width", timeoutMs: 10_000 },
        );
        expect(await frameAligned(s, "center")).toBe(true);
      },
    );
  });
});
