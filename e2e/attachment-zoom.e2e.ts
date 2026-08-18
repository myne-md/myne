// za1 — attachment image lightbox zoom/pan (MYND-594). Drives the production
// bundle: import a real image, embed it, click the inline chip to open the
// shared lightbox, then exercise open → zoom (button + keyboard) → pan → reset
// through the real UI. The image genuinely decrypts + loads in WebKit, so the
// zoom controller initialises against real dimensions (a headless flow mock
// can't — the img errors to a fallback chip).
//
// Vault-count precondition: 1 (weak KDF). The fixture image + filename are
// in-source scenario content, not credentials (SYNC-13). It reuses the OCR
// sample PNG — one binary, two consumers.
//
// ⚠ PLATFORM: tauri-driver, Linux-only. Authored on macOS; certify green 3× in
// the container (`./scripts/e2e-buildrun.sh attachment-zoom` — touches product
// code). See e2e/CLAUDE.md "definition of done".

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
import { type Session } from "./support/webdriver";

const FILENAME = "diagram.png";
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


/** The lightbox zoom percentage as a number (reads "NN%"). */
async function zoomPercent(s: Session): Promise<number> {
  const el = await s.byTestId("attachment-lightbox.zoom-percent");
  return parseInt((await el.textContent()).replace("%", ""), 10);
}

/** The image's current CSS transform string (translate + scale). */
async function imgTransform(s: Session): Promise<string> {
  return s.execute<string>(
    `return document.querySelector('[data-testid="attachment-lightbox.image"]').style.transform;`,
  );
}

describeE2E("za1 attachment image lightbox zoom/pan (MYND-594)", () => {
  it("opens the lightbox and zooms (button + keyboard), pans, and resets", async () => {
    let password = "";
    await scenario(
      "za1-attachment-zoom",
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

        // Wait until the inline chip's image has decoded + is displayed, then
        // click it to open the lightbox.
        await waitForInlineImage(s, attachmentId);
        // Re-click until the lightbox is up rather than clicking once and
        // waiting: a wait with nothing to re-fire spends its whole budget and
        // reports a timeout that reads like a dead surface. `clickByTestId`
        // hit-tests and scrolls the control into its own container first, which
        // a raw `.click()` does not, and `eo1` failed exactly this way on the
        // same widget until it was given this shape.
        await s.waitUntil(
          async () => {
            if ((await s.byTestIdAll("attachment-lightbox.image")).length > 0) return true;
            await clickByTestId(s, "attachment-image", { timeoutMs: 10_000 });
            return (await s.byTestIdAll("attachment-lightbox.image")).length > 0 ? true : null;
          },
          { label: "the attachment lightbox is open", timeoutMs: 30_000 },
        );
        await s.byTestId("attachment-lightbox.zoom-in");
        // The controller initialises to fit on load — wait for a real percentage.
        await s.waitUntil(
          async () => ((await zoomPercent(s)) > 0 ? true : null),
          { label: "zoom controller initialised" },
        );
        const fitPct = await zoomPercent(s);

        // Zoom in with the + button → the percentage rises.
        await (await s.byTestId("attachment-lightbox.zoom-in")).click();
        await s.waitUntil(
          async () => ((await zoomPercent(s)) > fitPct ? true : null),
          { label: "+ button zooms in" },
        );

        // Zoom in again with the KEYBOARD ("+") → it rises further.
        const afterButton = await zoomPercent(s);
        await (await s.byTestId("attachment-lightbox.zoom-percent")).sendKeys("+");
        await s.waitUntil(
          async () => ((await zoomPercent(s)) > afterButton ? true : null),
          { label: "keyboard + zooms in" },
        );

        // Pan while zoomed: a pointer drag on the image changes its translate.
        const before = await imgTransform(s);
        await s.execute(
          `const img = document.querySelector('[data-testid="attachment-lightbox.image"]');
           const r = img.getBoundingClientRect();
           const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
           const mk = (x, y) => ({ bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y });
           img.dispatchEvent(new PointerEvent('pointerdown', mk(cx, cy)));
           img.dispatchEvent(new PointerEvent('pointermove', mk(cx - 160, cy - 90)));
           img.dispatchEvent(new PointerEvent('pointerup', mk(cx - 160, cy - 90)));`,
        );
        await s.waitUntil(
          async () => ((await imgTransform(s)) !== before ? true : null),
          { label: "drag pans the image" },
        );

        // Reset via the percentage button → back to the fit percentage.
        await (await s.byTestId("attachment-lightbox.zoom-percent")).click();
        await s.waitUntil(
          async () => ((await zoomPercent(s)) === fitPct ? true : null),
          { label: "reset returns to fit" },
        );
      },
    );
  });
});
