// Review evidence for myne-md/myne#1049 (the owner's 0.17.0 pass).
//
// NOT a test: a CAPTURE pass, the same shape as `ui-pass.capture.ts` and riding
// the same real-IPC harness. It exists because a UI branch's review evidence is
// pixels, and the only automated seat that can produce them is the Linux /
// webkit2gtk container: tauri-driver has no macOS support, and capturing on the
// developer's own machine would photograph their real vault.
//
// It is written to run against TWO trees, the branch and its merge base, and the
// frame names are the pair key: `c1-...` from the branch and `c1-...` from the
// base are the after and before halves of one gallery row. Every frame is
// best-effort, so a surface the base does not have yet (a new control, a renamed
// testid) is recorded as a red or skipped frame instead of aborting the pass.
//
// Run: `./scripts/capture-ux-fixes.sh` (container), once per tree.

import { it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { harnessSupported, launchApp, REPO_ROOT } from "./../support/session";
import { seedVault } from "./../support/fixtures";
import {
  closeSettings,
  dismissImporterOffer,
  openSettings,
  runPaletteAction,
  selectSettingsTopic,
  unlockToEditor,
} from "./../support/flows";
import type { Session } from "./../support/webdriver";

const OUT_DIR = join(REPO_ROOT, "e2e", "artifacts", "ux-fixes");

interface FrameRecord {
  name: string;
  what: string;
  ok: boolean;
  note?: string;
}

const frames: FrameRecord[] = [];

async function frame(session: Session, name: string, what: string, build: () => Promise<void>): Promise<void> {
  try {
    await build();
    const png = await session.screenshot();
    writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(png, "base64"));
    frames.push({ name, what, ok: true });
    // eslint-disable-next-line no-console
    console.log(`[ux-fixes] OK ${name}.png — ${what}`);
  } catch (e) {
    const message = String(e);
    frames.push({ name, what, ok: false, note: message.slice(0, 200) });
    // eslint-disable-next-line no-console
    console.warn(`[ux-fixes] FAIL ${name}: ${message.slice(0, 160)}`);
  }
}

const supported = harnessSupported();
const runner = supported.ok ? it : it.skip;

runner(
  "captures the 0.17.0 owner-pass frames",
  async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    let password = "";
    const app = await launchApp({
      seed: (dir) => void (password = seedVault(dir, { kdf: "production" }).password),
    });
    const s = app.session;
    try {
      await unlockToEditor(s, password);
      await dismissImporterOffer(s);

      // The notes sidebar on the seeded vault, first: this is the surface the
      // branch changed most (event notes out of the tree, folder drag, folder
      // rename keeping its sort, the refusal moved to the shared toast).
      await frame(s, "c1-notes-sidebar", "The notes sidebar with a note in it.", async () => {
        await runPaletteAction(s, "note.new", "new note");
        await sleep(900);
        await s.byTestId("notes.tree", { timeoutMs: 20_000 });
        await sleep(500);
      });

      // Settings → Editor → Writing. The preview that used to sit under the
      // topic is gone on this branch.
      await frame(s, "c2-settings-editor-writing", "Settings → Editor → Writing.", async () => {
        await openSettings(s, "editor");
        await selectSettingsTopic(s, "editor", "writing");
        await sleep(600);
      });

      // Settings → Privacy. The hide-vault-names row no longer carries a `?`
      // disclosure, and its one sentence is the switch's consequence.
      await frame(s, "c3-settings-privacy-vault-names", "Settings → Privacy, the vault-name row.", async () => {
        await closeSettings(s);
        await openSettings(s, "privacy");
        // The panel AS IT OPENS, with no topic picked: the base and the branch
        // split this panel into topics differently, so naming one lands the two
        // halves on different sections and the pair stops comparing anything.
        await sleep(900);
      });

      // Quick unlock and Appearance are deliberately NOT frames: on Linux the
      // biometric button never renders (it is macOS-only), so the row is
      // pixel-identical to the base, and the appearance panel's only change on
      // this branch is mobile-side. A pair that looks the same proves nothing and
      // reads as a broken capture.

      // The calendar: full-bleed, design-system date and time fields, created
      // from the palette so the frame is the surface and not the palette.
      await frame(s, "c6-calendar", "The calendar tab.", async () => {
        await closeSettings(s);
        await runPaletteAction(s, "calendar.show", "calendar");
        await sleep(1200);
      });

    } finally {
      await app.teardown();
      // eslint-disable-next-line no-console
      console.log(
        `[ux-fixes] summary: ${frames.filter((f) => f.ok).length} captured, ` +
          `${frames.filter((f) => !f.ok).length} failed — ${JSON.stringify(frames)}`,
      );
    }
  },
  900_000,
);
