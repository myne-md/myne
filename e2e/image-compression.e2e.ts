// ic1 — ingest-time image compression (feature `ingest-image-compression`),
// through the production binary.
//
// Pins the user-visible half of the feature: an image inserted into a note is
// silently made smaller, and the user is TOLD so at the moment it happens —
// and turning the preference off really does store what was pasted, byte for
// byte. Both halves run against the same source image in one scenario, because
// the second half only means anything as a contrast with the first.
//
//   1. Paste an oversized image (3000 px long edge, above the 2400 px
//      ceiling) → the compression notice appears, reporting the ORIGINAL size
//      and the container swap (PNG → WebP). Reporting the original size is the
//      load-bearing part: the stored attachment no longer knows it, so a notice
//      that echoed the stored size would disclose nothing.
//   2. Turn Settings → Files → "Compress images on import" OFF, paste the same
//      source again → NO notice appears, and the catalog's `size` for that
//      import equals the source file's byte length exactly. Byte-identical
//      storage is the promise the preference makes; anything less is a silent
//      lossy transform the user opted out of.
//
// What is driven vs. asserted:
//   - The insert is a SYNTHETIC `paste` event carrying a real `File` on a real
//     `DataTransfer`, dispatched at the live `.cm-content`. WebDriver cannot
//     put an image on the system clipboard, and the OS file picker behind
//     `/attach` is equally undrivable — the `userguide.capture.ts` precedent
//     synthesises a paste the same way. This is real UI driving: the CM6
//     `domEventHandlers` paste handler (editor/src/attachments/paste-drop.ts)
//     receives the event the browser would have delivered, and everything past
//     it — import IPC, compression, the embed insert, the toast — is the real
//     flow. Deliberately NOT `pageSeatInvoke` on `attachment_import`, which is
//     how every other attachment scenario imports: the notice lives in the
//     editor insert pipeline, so an IPC-only import would skip the thing under
//     test.
//   - The catalog is re-read via page-seat `catalog_list` — the disk truth,
//     not the editor's in-memory row cache (the al1 precedent).
//   - The absence assertion in half 2 SAMPLES the toast surface continuously
//     from the paste until well after the import lands, rather than checking
//     once. The toast auto-dismisses after 3.2 s
//     (`editor/src/attachments/toast.ts` DEFAULT_DURATION_MS), so a single
//     late check could pass vacuously against a notice that came and went.
//
// The source image is `.github/banner.png` (3000×1046, 152 401 bytes), an asset
// already tracked in this repo rather than a new fixture: it is the same image
// the feature's constant-measurement pass used (feature `progress.md`, task 2),
// so its compressed size is a known quantity, and one binary with two consumers
// beats a duplicate.
//
// Vault-count precondition: 1. KDF: weak generator fixture (unlock reads params
// from vault.meta).
// SYNC-13: nothing asserted here is credential-bearing — the assertions are
// byte counts and the notice string. The attachment filenames are in-source
// scenario constants.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  openSettings,
  pageSeatInvoke,
  unlockToEditor,
} from "./support/flows";
import { REPO_ROOT } from "./support/session";
import { testIdSelector, type Session } from "./support/webdriver";

const CM_CONTENT = '[data-testid="editor.content"] .cm-content';
const TOAST = testIdSelector("attachment-toast");
const COMPRESSION_SWITCH = "settings.attachment-compression";

/** Mirrors `showAttachmentToast`'s DEFAULT_DURATION_MS. An absence window
 *  shorter than this could step over a notice that appeared and vanished. */
const TOAST_LIFETIME_MS = 3_200;

const IPC_TIMEOUT = 20_000;

/** Distinct display names so the two imports are unambiguous in the catalog.
 *  Single lowercase-alnum tokens (residue needle rule). */
const NAME_COMPRESSED = "bannerpasteon7q2w9.png";
const NAME_UNCOMPRESSED = "bannerpasteoff4m8k3.png";

/** 3000×1046 — long edge above the 2400 px ceiling, so the downscale rule and
 *  the lossless-WebP re-encode both fire and the container changes. */
function sourceBytes(): Buffer {
  return readFileSync(join(REPO_ROOT, ".github", "banner.png"));
}

/**
 * Dispatch a synthetic `paste` carrying one image file at the live editor
 * content, asserting that the `DataTransfer` really carried it: one that
 * silently refused `items.add` would make the whole scenario pass vacuously
 * (no paste, no notice, nothing imported).
 */
async function pasteImage(s: Session, base64: string, filename: string): Promise<void> {
  const carried = await s.execute<number>(
    "var el = document.querySelector(arguments[0]);" +
      "var bin = atob(arguments[1]);" +
      "var buf = new Uint8Array(bin.length);" +
      "for (var i = 0; i < bin.length; i++) { buf[i] = bin.charCodeAt(i); }" +
      "var dt = new DataTransfer();" +
      "dt.items.add(new File([buf], arguments[2], { type: 'image/png' }));" +
      "el.focus();" +
      "el.dispatchEvent(new ClipboardEvent('paste', " +
      "{ clipboardData: dt, bubbles: true, cancelable: true }));" +
      "return dt.files.length;",
    [CM_CONTENT, base64, filename],
  );
  expect(carried, "the synthetic clipboard must carry exactly one file").toBe(1);
}

/** The toast's text, or `null` when no toast is showing. Read in ONE round
 *  trip so a toast that auto-dismisses between find and read cannot turn into
 *  a stale-element throw. */
function toastText(s: Session): Promise<string | null> {
  return s.execute<string | null>(
    "var el = document.querySelector(arguments[0]); return el ? el.textContent : null;",
    [TOAST],
  );
}

/** Catalog rows re-read via page-seat IPC (the disk truth). */
async function catalog(
  s: Session,
): Promise<Array<{ id: string; filename: string; size: number }>> {
  const r = await pageSeatInvoke(s, "plugin:attachments|catalog_list", {}, IPC_TIMEOUT);
  expect(r.err, "catalog_list should succeed").toBeUndefined();
  return r.ok as Array<{ id: string; filename: string; size: number }>;
}

/** The catalog row whose filename starts with `stem`, once it exists. */
async function rowFor(
  s: Session,
  stem: string,
): Promise<{ id: string; filename: string; size: number }> {
  return s.waitUntil(
    async () => (await catalog(s)).find((r) => r.filename.startsWith(stem)) ?? null,
    { label: `catalog row for ${stem}`, timeoutMs: 90_000 },
  );
}

/** Drive the Settings → Files compression switch to `enabled`, clicking only
 *  when it is not already there, and wait for `aria-checked` to reflect the
 *  persisted value. (An unconditional click would hang out its full timeout
 *  when called for the state the switch is already in.) */
async function setCompressionEnabled(s: Session, enabled: boolean): Promise<void> {
  await openSettings(s, "files");
  const checked = async () =>
    (await (await s.byTestId(COMPRESSION_SWITCH)).attribute("aria-checked")) === String(enabled);
  if (!(await checked())) await (await s.byTestId(COMPRESSION_SWITCH)).click();
  await s.waitUntil(async () => ((await checked()) ? true : null), {
    label: `attachment_compression_enabled = ${enabled}`,
    timeoutMs: 15_000,
  });
  await closeSettings(s);
}

describeE2E("ic1 ingest-time image compression (ingest-image-compression)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("discloses the compression on insert, and stores the source verbatim when off", async () => {
    let seeded: SeededVault;
    const source = sourceBytes();
    const base64 = source.toString("base64");
    // `formatBytes(152401)` — 148.83 KiB, which the formatter rounds to whole
    // units once the value passes 10. So "149 KiB", not "148.8 KiB".
    const expectedFrom = "149 KiB";
    const expectedFromKib = 149;

    await scenario(
      "ic1-image-compression",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);
        await createNote(s, "compressionnote6h3p1");

        // ---- 1. preference ON (the default): paste → notice ----
        await (await s.waitForElement(CM_CONTENT)).click();
        await pasteImage(s, base64, NAME_COMPRESSED);

        // Poll the toast text directly; the decode → Lanczos3 downscale →
        // lossless-WebP encode runs before it appears, so the budget is
        // generous, but the toast only lives 3.2 s once it does.
        const notice = await s.waitUntil(async () => (await toastText(s)) || null, {
          label: "compression notice",
          timeoutMs: 90_000,
        });

        // Full shape: the container swap is named, and the "from" size is the
        // ORIGINAL file's — the one nothing on disk remembers any more.
        const match = /^Compressed to WebP: (.+) → ([\d.]+) KiB$/.exec(notice.trim());
        expect(match, `unexpected notice text: ${JSON.stringify(notice)}`).not.toBeNull();
        expect(match?.[1], "the notice must report the pre-compression size").toBe(
          expectedFrom,
        );
        expect(
          Number(match?.[2]),
          "the notice's stored size must be smaller than the source",
        ).toBeLessThan(expectedFromKib);

        // The stored bytes really are the compressed ones: the catalog row is
        // smaller than the source and carries the new container's extension.
        const compressed = await rowFor(s, "bannerpasteon");
        expect(compressed.size).toBeLessThan(source.length);
        expect(compressed.filename).toBe("bannerpasteon7q2w9.webp");

        // ---- 2. preference OFF: paste → no notice, source stored verbatim ----
        await s.waitForGone(TOAST, { timeoutMs: 15_000 });
        await setCompressionEnabled(s, false);

        await (await s.waitForElement(CM_CONTENT)).click();
        await pasteImage(s, base64, NAME_UNCOMPRESSED);

        // Sample the toast surface from the paste until TOAST_LIFETIME_MS past
        // the moment the import lands in the catalog: a notice cannot slip
        // through a window that both brackets the import and outlives one
        // toast. The catalog is polled less often than the toast — it costs an
        // IPC round trip, while missing a toast sample is the failure that
        // matters.
        const start = Date.now();
        let stored: number | null = null;
        let landedAt = 0;
        for (let tick = 0; ; tick++) {
          expect(
            await toastText(s),
            "no notice may appear when compression is off",
          ).toBeNull();
          if (stored === null) {
            if (tick % 5 === 0) {
              const row = (await catalog(s)).find((r) =>
                r.filename.startsWith("bannerpasteoff"),
              );
              if (row !== undefined) {
                stored = row.size;
                landedAt = Date.now();
              }
            }
            if (Date.now() - start > 90_000) {
              throw new Error("the preference-off import never reached the catalog");
            }
          } else if (Date.now() - landedAt > TOAST_LIFETIME_MS + 1_500) {
            break;
          }
          await sleep(100);
        }

        // Byte-for-byte: what the user pasted is what the vault holds.
        expect(stored, "the stored size must equal the source's byte length").toBe(
          source.length,
        );
        // ...and the filename kept its original extension, since no re-encode
        // happened to change the container.
        expect((await rowFor(s, "bannerpasteoff")).filename).toBe(NAME_UNCOMPRESSED);
      },
    );
  });
});
