// Video attachments (myne#168) — vault-count precondition: 1.
//
// Pins the load-bearing chain for inline video through the production binary: a
// real MP4 / WebM imported via the `plugin:attachments|attachment_import` IPC is
// classified by the magic-byte sniffer as `video/mp4` / `video/webm` (the inline
// player's served source), survives a catalog re-read ("reopen"), and an
// out-of-scope MOV degrades to `application/octet-stream` because the brand-gate
// excludes QuickTime's `qt  ` major brand (SYNC-2 of the video-attachments epic).
//
// Per `e2e/AGENTS.md` the inline `<video>` widget RENDER and the
// error→file-card fallback are Vitest-DOM concerns, covered in
// `tests/editor/attachment-widgets.test.tsx` (routing + native controls + the
// graceful swap). This scenario proves the data chain that player rides on — the
// sniffer's new `video/*` arms exercised through the real ACL — not pixels, and
// not media playback (headless WebKit has no codec on the runner).
//
// SYNC-13: no credential appears in any assert. KDF: weak generator fixtures
// (unlock reads params from vault.meta).
//
// ⚠️ NEW SCENARIO — authored but NOT yet validated in the container. Per
// `e2e/AGENTS.md` definition of done it must go green 3× consecutive via
// `./scripts/e2e-buildrun.sh e2e/video-attachment.e2e.ts` before merge (it
// exercises the new `video/mp4` + `video/webm` sniffer arms through the real
// attachment-import ACL; tauri-driver is Linux-only, so it cannot run on macOS).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import { dismissImporterOffer, pageSeatInvoke, unlockToEditor } from "./support/flows";
import { type Session } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;
const HERE = dirname(fileURLToPath(import.meta.url));

// Tiny (~1–2 KB) 64×64 1-second clips generated with ffmpeg: tiny.mp4 (H.264,
// `isom` brand → video/mp4), tiny.webm (VP9, `webm` DocType → video/webm),
// tiny.mov (H.264 in a QuickTime container, `qt  ` brand → excluded).
function fixtureBytes(name: string): number[] {
  return Array.from(readFileSync(join(HERE, "fixtures", "video", name)));
}

async function importVideo(
  s: Session,
  name: string,
  filename: string,
): Promise<{ id: string; contentType: string }> {
  const r = await pageSeatInvoke(
    s,
    "plugin:attachments|attachment_import",
    { source: { kind: "bytes", bytes: fixtureBytes(name), filename } },
    IPC_TIMEOUT,
  );
  expect(r.err, `attachment_import should accept ${filename}`).toBeUndefined();
  const ok = r.ok as { id: string; content_type: string };
  return { id: ok.id, contentType: ok.content_type };
}

describeE2E("video attachments (myne#168)", () => {
  it("va1 — MP4 + WebM classify as video/*, MOV → octet-stream, all survive a catalog reopen", async () => {
    let seeded: SeededVault;
    await scenario(
      "va1-video-attachment",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // ---- MP4 (H.264, isom brand) → video/mp4 ----
        const mp4 = await importVideo(s, "tiny.mp4", "clip.mp4");
        expect(mp4.contentType, "an isom-brand MP4 classifies as video/mp4").toBe("video/mp4");

        // ---- WebM (VP9, webm DocType) → video/webm ----
        const webm = await importVideo(s, "tiny.webm", "clip.webm");
        expect(webm.contentType, "a webm-DocType file classifies as video/webm").toBe("video/webm");

        // ---- MOV (qt brand, OUT of scope) → octet-stream (the brand-gate excludes it) ----
        const mov = await importVideo(s, "tiny.mov", "clip.mov");
        expect(
          mov.contentType,
          "a QuickTime MOV is excluded from video/* and stores as octet-stream (the file card)",
        ).toBe("application/octet-stream");

        // ---- reopen: the classifications survive a catalog re-read (the served source) ----
        const list = await pageSeatInvoke(s, "plugin:attachments|catalog_list", {}, IPC_TIMEOUT);
        expect(list.err, "catalog_list should succeed").toBeUndefined();
        const rows = list.ok as Array<{ id: string; content_type: string }>;
        const typeOf = (id: string): string | undefined =>
          rows.find((r) => r.id === id)?.content_type;
        expect(typeOf(mp4.id), "MP4 stays video/mp4 across reopen").toBe("video/mp4");
        expect(typeOf(webm.id), "WebM stays video/webm across reopen").toBe("video/webm");
        expect(typeOf(mov.id), "MOV stays octet-stream across reopen").toBe("application/octet-stream");
      },
    );
  });
});
