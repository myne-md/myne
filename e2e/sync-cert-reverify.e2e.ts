// Settings → Sync: re-verifying the certificate of an endpoint already connected
// (myne#756).
//
// # The regression this holds down
//
// When a self-hosted server renews its certificate, `sync_set_endpoint` refuses
// to adopt the new leaf (`CertificateChanged`, myne#581) and the device panel
// tells the user to "re-enter the server URL under Sync server above to
// re-trust it". That instruction could not be carried out: `EndpointConfig`
// renders Connect as a DISABLED "Connected" whenever the typed URL equals the
// connected one, which is exactly what re-entering the same URL produces. The
// fingerprint gate the refusal raises was therefore unreachable for the only
// endpoint it was ever written about, and sync stayed down permanently with a
// greyed-out button next to a red error telling the user to press it.
//
// # Why no server is spawned, and what that costs
//
// The harness has no TLS: `syncConfigSeed` points every other sync scenario at
// a loopback `http` server, so `pin_source` is `None` on all of them and this
// whole surface renders on no device the suite launches. `pinnedHttpsConfigSeed`
// writes a pinned `https` config instead, which `sync_get_endpoint` reads off
// disk with no handshake — so the screen reaches the connected state against a
// URL nothing answers.
//
// What that buys is the bug: #756 was never in the handshake, it was in whether
// a user could REACH the gate without editing the URL, and that is decided
// entirely by what this scenario drives. What it does not buy is the second
// half — that a pasted fingerprint is compared and the pin replaced. That needs
// a TLS server with a rotatable certificate, is covered by
// `core/src/plugins/sync/pin_confirm.rs`'s own tests plus the `same_endpoint`
// tests in `config.rs`, and is named in the manual-test roster as the
// device-level check no lane here can make.
//
// KDF: weak generator fixtures (params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { harnessSupported } from "./support/session";
import { launchDevice, pinnedHttpsConfigSeed } from "./support/multi-device";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  dismissImporterOffer,
  openSettings,
  unlockToEditor,
} from "./support/flows";

const supported = harnessSupported().ok;

describe.skipIf(!supported)("cr · re-verifying a pinned certificate (myne#756)", () => {
  it("cr1 — the re-verify door is reachable while Connect rests disabled, and opens the gate without editing the URL", async () => {
    let password = "";
    const a = await launchDevice(0, {
      seedConfig: pinnedHttpsConfigSeed(),
      seed: (appDataDir) => {
        password = seedVault(appDataDir, { password: "CanaryPass-9-animals!" }).password;
      },
    });
    try {
      await unlockToEditor(a.session, password);
      await dismissImporterOffer(a.session);
      await openSettings(a.session);
      await (await a.session.byTestId("settings.tab-sync")).click();

      // The screen has read the stored config: a TOFU pin, so the fingerprint
      // callout is rendered. Waiting on this rather than on the button is what
      // makes every assertion below one about the LOADED state — the form
      // renders complete, with Connect enabled, before the config arrives.
      await a.session.byTestId("sync.cert-fingerprint", { timeoutMs: 20_000 });
      expect(await (await a.session.byTestId("sync.pin-source")).attribute("data-pin-source")).toBe(
        "tofu",
      );

      // The locked room: the URL is untouched, so Connect is inert.
      expect(await (await a.session.byTestId("sync.endpoint-connect")).enabled()).toBe(false);

      // The door out of it, and the gate it opens — with the URL never edited.
      const before = await (await a.session.byTestId("sync.endpoint-input")).property<string>(
        "value",
      );
      expect(await a.session.byTestIdAll("sync.fingerprint-gate")).toHaveLength(0);
      await (await a.session.byTestId("sync.endpoint-reverify")).click();
      await a.session.byTestId("sync.fingerprint-gate");
      await a.session.byTestId("sync.expected-fingerprint-input");
      expect(
        await (await a.session.byTestId("sync.endpoint-input")).property<string>("value"),
      ).toBe(before);

      await closeSettings(a.session);
    } finally {
      await a.teardown();
    }
  });
});
