// Device-join QR branding (myne-md/myne#481): the branded QR renders in
// Settings -> Sync on a single enrolled device.
//
// Vault-count precondition: 1 seeded vault (boots to unlock).
//
// This is a RENDER / integration regression guard, NOT scannability. A WebKitGTK
// container has no camera, so whether a phone can read the code is the manual test
// roster's job (the `sync.device-join` entry). What this proves end-to-end over the
// real myne-server + the production app: pasting the account number and pressing
// Make QR renders the branded image, and the render site
// (`sync::qr::render_qr_svg`) composes the Myne mark into the SVG at the literal
// ink colour. Self-skips off-platform / without the myne-server binary, like
// sync-usage.e2e.ts.
//
// KDF: weak generator fixtures (params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { harnessSupported } from "./support/session";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import { launchDevice, syncConfigSeed } from "./support/multi-device";
import { seedVault } from "./support/fixtures";

import {
  ipcOk,
  openSettings,
  unlockAndEnroll,
} from "./support/flows";

const supported = harnessSupported().ok && syncServerSupported().ok;

if (!supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `[e2e] device-join-qr skipped: ${
      !harnessSupported().ok
        ? harnessSupported().reason
        : syncServerSupported().reason
    }`,
  );
}

describe.skipIf(!supported)(
  "djq · device-join QR branding (myne-md/myne#481)",
  () => {
    it("djq1: Make QR renders the branded image, and the SVG carries the Myne mark", async () => {
      const srv = await startSyncServer();
      let account = "";
      let password = "";
      const a = await launchDevice(0, {
        seedConfig: syncConfigSeed(srv.url),
        seed: (appDataDir) => {
          const v = seedVault(appDataDir, { password: "CanaryPass-9-animals!" });
          account = v.account;
          password = v.password;
        },
      });
      try {
        await unlockAndEnroll(a.session, account, password);

        // Settings -> Sync: paste the account number and press Make QR. The input
        // mask adds dashes; the parser strips them (account-number.md), so the
        // canonical seeded account round-trips through the production flow.
        await openSettings(a.session);
        await (await a.session.byTestId("settings.tab-sync")).click();
        // The QR lives in a dialog opened from the Devices header icon
        // (myne-md/myne#831), not an always-visible block.
        await (await a.session.byTestId("sync.device-join-qr.open")).click();
        await a.session.byTestId("sync.device-join-qr.dialog");
        await (
          await a.session.byTestId("sync.device-join-qr.account-input")
        ).sendKeys(account);
        await (await a.session.byTestId("sync.device-join-qr.generate")).click();

        // The branded image renders: the command -> render -> <img> wiring holds.
        await a.session.byTestId("sync.device-join-qr.image", {
          timeoutMs: 20_000,
        });

        // The render site composes the Myne mark into the SVG at the literal ink
        // colour. Asserted on the command OUTPUT because the DOM shows only an
        // object-URL <img> whose bytes are not readable from the page. This is a
        // regression guard on the overlay, NOT scannability (manual roster).
        const qr = (await ipcOk(a.session, "plugin:sync|sync_device_join_qr", {
          accountNumber: account,
        })) as { svg: string; ttl_secs: number };
        expect(qr.svg).toContain("M8 22 V10 L16 18 L24 10 V22");
        expect(qr.svg).toContain("#1a1a17");
      } finally {
        await a.teardown();
        await srv.teardown();
      }
    });
  },
);
