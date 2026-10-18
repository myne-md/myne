// ic1 — ingest-time image compression (feature `ingest-image-compression`),
// through the production binary.
//
// Pins the user-visible half of the feature: an image inserted into a note is
// silently made smaller, and the user is TOLD so at the moment it happens —
// and turning the preference off really does store what was pasted, byte for
// byte. Both halves run against the same source image in one scenario, because
// the second half only means anything as a contrast with the first.
//
//   1. Paste an oversized image (2500 px long edge, above the 2400 px
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
// The source image is GENERATED, not read off disk: `support/bloated-png.ts`
// explains why in full. In one line, this scenario needs a source whose
// re-encode is reliably smaller, and a shared repo asset cannot promise that —
// `.github/banner.png` was the source until it was redrawn in `e98353fd` and its
// lossless-WebP re-encode came out 6 % LARGER than the source, so the
// compressor's not-smaller guard correctly declined to compress and the notice
// never appeared. 2500x240 is above the 2400 px ceiling (so the downscale rule
// fires) and re-encodes at ~0.76x of the source's bytes.
//
// Vault-count precondition: 1. KDF: weak generator fixture (unlock reads params
// from vault.meta).
// SYNC-13: nothing asserted here is credential-bearing — the assertions are
// byte counts and the notice string. The attachment filenames are in-source
// scenario constants.

import { setTimeout as sleep } from "node:timers/promises";

import { formatBytes } from "@myne/editor/host/components/attachments/format";

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { bloatedPng } from "./support/bloated-png";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  openSettings,
  pageSeatInvoke,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const CM_CONTENT = '[data-testid="editor.content"] .cm-content';
const TOAST = testIdSelector("attachment-toast");
const COMPRESSION_SWITCH = "settings.attachment-compression";

/** Mirrors `showAttachmentToast`'s DEFAULT_DURATION_MS. An absence window
 *  shorter than this could step over a notice that appeared and vanished. */
const TOAST_LIFETIME_MS = 3_200;

/** What a compression disclosure looks like, in either of its two wordings
 *  (`editor.attachment.compression.notice` / `…noticeContainerChanged`). Both
 *  end in the `<from> → <to>` byte pair, which is the part that constitutes the
 *  disclosure — a sentence without it is some other toast. */
const COMPRESSION_NOTICE = /\d[\d.]*\s*[KMG]?i?B\s*→\s*\d[\d.]*\s*[KMG]?i?B/;

const IPC_TIMEOUT = 20_000;

/** Distinct display names so the two imports are unambiguous in the catalog.
 *  Single lowercase-alnum tokens (residue needle rule). */
const NAME_COMPRESSED = "fixturepasteon7q2w9.png";
const NAME_UNCOMPRESSED = "fixturepasteoff4m8k3.png";

/**
 * 2500x240 — long edge above the 2400 px ceiling, so the downscale rule fires
 * and the container changes PNG -> WebP. See the header for why this is
 * generated rather than read from the repo.
 */
const SOURCE_WIDTH = 2500;
const SOURCE_HEIGHT = 240;
const source = bloatedPng(SOURCE_WIDTH, SOURCE_HEIGHT);
const base64 = source.toString("base64");

/**
 * The size the notice must report, in the app's own formatter.
 *
 * Imported from the module the UI reads (`editor/src/attachments/insert.ts`
 * formats both figures with it) rather than pinned as a literal: the value this
 * used to carry ("149 KiB") was the OLD banner's size, so it would have failed
 * the notice-text assertion even in a run where compression happened. One
 * authority on the rounding rule, and it moves with the fixture.
 *
 * For THIS fixture that is "1.7 MiB" — 1 800 573 bytes, which the formatter
 * promotes past KiB on its way up.
 */
const expectedFrom = formatBytes(source.length);

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
 *  a stale-element throw.
 *
 *  BOTH surfaces, and that is the fix this scenario needed.
 *  `showAttachmentToast` has two paths (`editor/src/attachments/toast.ts`):
 *  when the app has installed a toast SINK it forwards to the central store and
 *  the message renders as `editor.toast`; only WITHOUT a sink does it build the
 *  standalone `attachment-toast` node itself. The running desktop app installs
 *  the sink, so the compression notice has been arriving as `editor.toast` —
 *  and this scenario polled the fallback testid alone, for 90 s, and reported
 *  a timeout that read like "compression never disclosed anything".
 *
 *  It was not. The diagnostic below showed the catalog holding
 *  `…​.webp` at 97 KiB from a 149 KiB PNG source: the compression and the
 *  container swap both happened. Only the reader was pointed at the wrong node.
 *
 *  Reading both keeps the assertion true on either path rather than pinning
 *  today's wiring — the disclosure is what matters, not which element carries
 *  it. `editor.toast-message` is the message span specifically: the toast root
 *  renders the icon span first, and that one holds an SVG with no text. */
function toastText(s: Session): Promise<string | null> {
  return s.execute<string | null>(
    "var el = document.querySelector(arguments[0]);" +
      "if (el) return el.textContent;" +
      "var m = document.querySelector('[data-testid=\"editor.toast-message\"]');" +
      "return m ? m.textContent : null;",
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
        //
        // On timeout, say WHICH of the three things went wrong instead of
        // reporting 90 s of silence. "waitUntil(compression notice) timed out"
        // is true of a paste that never became an attachment, of an attachment
        // that was never compressed, and of a notice that rendered under a
        // different testid — three different bugs with one message. The catalog
        // is the disk truth and costs one IPC, and it is only read on the way
        // to failing anyway.
        let notice: string;
        try {
          notice = await s.waitUntil(async () => (await toastText(s)) || null, {
            label: "compression notice",
            timeoutMs: 90_000,
          });
        } catch (e) {
          const rows = await catalog(s).catch(() => [] as Array<{ filename: string; size: number }>);
          const anyToast = await s.execute<string | null>(
            "var t = document.querySelector('[data-testid=\"attachment-toast\"]');" +
              "var r = document.querySelector('[data-testid=\"editor.toast\"]');" +
              "return t ? 'attachment-toast: ' + t.textContent : (r ? 'editor.toast: ' + r.textContent : null);",
          );
          throw new Error(
            `${(e as Error).message}\n` +
              `  attachments in the catalog: ${JSON.stringify(rows.map((r) => ({ f: r.filename, size: r.size })))}\n` +
              `  any toast on screen: ${anyToast ?? "none"}\n` +
              `  (empty catalog => the paste never imported; a row with the ORIGINAL size => ` +
              `import worked and compression did not; a toast under another testid => the notice moved)`,
          );
        }

        // Full shape: the container swap is named, and the "from" size is the
        // ORIGINAL file's — the one nothing on disk remembers any more.
        //
        // Unit-agnostic on purpose. This used to be
        // `/^Compressed to WebP: (.+) → ([\d.]+) KiB$/` and the trailing `KiB`
        // is a hardcoded unit: the formatter promotes to MiB above 1024 KiB, so
        // a fixture big enough to produce "1.7 MiB → 1.3 MiB" failed on the
        // REGEX rather than on anything about compression. Both figures are now
        // compared against `formatBytes` in the same shape the UI uses, so no
        // unit arithmetic lives here at all.
        const match = /^Compressed to WebP: (.+) → (.+)$/.exec(notice.trim());
        expect(match, `unexpected notice text: ${JSON.stringify(notice)}`).not.toBeNull();
        expect(match?.[1], "the notice must report the pre-compression size").toBe(
          expectedFrom,
        );

        // The stored bytes really are the compressed ones: the catalog row is
        // smaller than the source and carries the new container's extension.
        const compressed = await rowFor(s, "fixturepasteon");
        expect(compressed.size).toBeLessThan(source.length);
        expect(compressed.filename).toBe("fixturepasteon7q2w9.webp");

        // ...and the notice's second figure is the size the VAULT holds, not a
        // number the UI arrived at on its own. Comparing it to the catalog row
        // is what makes "the user was told the truth" an assertion about disk.
        expect(match?.[2], "the notice's stored size must be the size on disk").toBe(
          formatBytes(compressed.size),
        );

        // ---- 2. preference OFF: paste → no notice, source stored verbatim ----
        // Wait for phase 1's OWN notice to clear, on whichever surface carried
        // it. `waitForGone(TOAST)` alone returned instantly and always has:
        // `attachment-toast` is the fallback node, which the running app never
        // builds because it installs a toast sink. The store-backed toast lives
        // longer than the fallback's 3.2 s, so phase 2's absence assertion was
        // reading phase 1's message and failing on it — an absence assertion
        // that never got a chance to be about phase 2 at all.
        await s.waitForGone(TOAST, { timeoutMs: 15_000 });
        await s.waitUntil(
          async () => {
            const t = await toastText(s);
            return t === null || !COMPRESSION_NOTICE.test(t) ? true : null;
          },
          { label: "phase-1 compression notice cleared", timeoutMs: 20_000 },
        );
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
          // A COMPRESSION notice, not "any toast". `toastText` reads the shared
          // toast surface, and an ordinary insert may legitimately toast about
          // something else (a batch summary, an error); asserting "no toast at
          // all" would fail on those and would be asserting the wrong thing —
          // what must not happen here is a claim that bytes were re-encoded.
          const showing = await toastText(s);
          expect(
            showing === null || !COMPRESSION_NOTICE.test(showing),
            `no compression notice may appear when compression is off (saw: ${JSON.stringify(showing)})`,
          ).toBe(true);
          if (stored === null) {
            if (tick % 5 === 0) {
              const row = (await catalog(s)).find((r) =>
                r.filename.startsWith("fixturepasteoff"),
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
        expect((await rowFor(s, "fixturepasteoff")).filename).toBe(NAME_UNCOMPRESSED);
      },
    );
  });
});
