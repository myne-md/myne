// Settings → Sync on a previously configured HTTPS endpoint (myne#786).
// Vault-count precondition: 1. A saved URL is seeded before boot; no server is
// contacted, so this checks the live UI and not the TLS handshake. The native
// verifier's accept/reject paths run against a CA-signed fixture in myne-core.
//
// KDF: weak generator fixtures (params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { harnessSupported } from "./support/session";
import { launchDevice, httpsConfigSeed } from "./support/multi-device";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  dismissImporterOffer,
  openSettings,
  unlockToEditor,
} from "./support/flows";

const supported = harnessSupported().ok;

describe.skipIf(!supported)("cr · trusted HTTPS configuration (myne#786)", () => {
  it("cr1: a saved HTTPS endpoint needs no manual certificate verification", async () => {
    let password = "";
    const a = await launchDevice(0, {
      seedConfig: httpsConfigSeed(),
      seed: (appDataDir) => {
        password = seedVault(appDataDir, { password: "CanaryPass-9-animals!" }).password;
      },
    });
    try {
      await unlockToEditor(a.session, password);
      await dismissImporterOffer(a.session);
      await openSettings(a.session);
      await (await a.session.byTestId("settings.tab-sync")).click();

      // The screen has read the stored config, so the trust callout is
      // rendered. Waiting on this rather than on the button is what
      // makes every assertion below one about the LOADED state — the form
      // renders complete, with Connect enabled, before the config arrives.
      await a.session.byTestId("sync.pin-source", { timeoutMs: 20_000 });
      expect(await (await a.session.byTestId("sync.pin-source")).attribute("data-pin-source")).toBe(
        "platform_trust_store",
      );

      // The locked room: the URL is untouched, so Connect is inert.
      expect(await (await a.session.byTestId("sync.endpoint-connect")).enabled()).toBe(false);

      // The door out of it, and the gate it opens — with the URL never edited.
      const before = await (await a.session.byTestId("sync.endpoint-input")).property<string>(
        "value",
      );
      expect(await a.session.byTestIdAll("sync.fingerprint-gate")).toHaveLength(0);
      expect(await a.session.byTestIdAll("sync.endpoint-reverify")).toHaveLength(0);
      expect(await a.session.byTestIdAll("sync.cert-fingerprint")).toHaveLength(0);
      expect(
        await (await a.session.byTestId("sync.endpoint-input")).property<string>("value"),
      ).toBe(before);

      await closeSettings(a.session);
    } finally {
      await a.teardown();
    }
  });
});
