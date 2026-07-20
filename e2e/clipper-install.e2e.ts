// Browser-clipper host-install toggle suite (installer wiring, decisions.md
// 2026-07-05; default flipped to OFF by MYND-549). Drives Settings → Account →
// "Browser clipper" through the REAL editor UI on the tauri-driver harness.
//
//   ci1 — TOGGLE ROUND-TRIP: the toggle renders OFF by default (absent flag ⇒
//         disabled, the privacy-preserving default), flips to ON, then back OFF.
//         The `data-enabled` attribute is driven by the command's RETURNED status
//         (optimistic value rolls back on failure), so a clean false→true→false
//         exercises the real `clipper_install_status` (mount read) +
//         `clipper_install_set_enabled` (write flag + reconcile the on-disk
//         manifests) commands end-to-end.
//
// The manifest FILE writes land in the browser profile dirs (outside the vault),
// which tauri-driver cannot assert directly; the Rust unit tests over a
// `ScopedTempDir` fake browser root (`clipper::install` tests) cover the
// filesystem reconcile. This scenario is the UI/IPC round-trip half.
//
// The install flag + manifests are NON-vault, NON-crypto config (host name +
// binary path + public extension ids) — no new magic / KEK / AAD / format.
//
// KDF: weak generator fixtures (params are vault.meta-resident).

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  dismissImporterOffer,
  openSettings,
  unlockToEditor,
} from "./support/flows";
import { type Session } from "./support/webdriver";

/** Wait until the install block's reflected `data-enabled` equals `expected`. */
async function waitEnabled(session: Session, expected: "true" | "false"): Promise<void> {
  await session.waitUntil(
    async () =>
      (await (await session.byTestId("settings.clipper-install")).attribute("data-enabled")) ===
      expected
        ? true
        : null,
    { label: `clipper install enabled = ${expected}`, timeoutMs: 10_000 },
  );
}

describeE2E("ci1 browser-clipper host-install toggle (decisions.md 2026-07-05)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the Browser clipper toggle renders off by default and round-trips on→off", async () => {
    let password = "";
    await scenario(
      "ci1-clipper-install-toggle",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Settings → Account (the default panel) hosts the toggle.
        await openSettings(s, "account");
        await s.byTestId("settings.clipper-install");

        // Default: absent flag ⇒ NOT registered ⇒ toggle OFF (MYND-549).
        await waitEnabled(s, "false");

        // Flip ON — writes the flag + installs the manifests, returns enabled=true.
        await (await s.byTestId("settings.clipper-install-toggle")).click();
        await waitEnabled(s, "true");

        // Flip back OFF — removes the manifests, returns enabled=false.
        await (await s.byTestId("settings.clipper-install-toggle")).click();
        await waitEnabled(s, "false");

        await closeSettings(s);
      },
    );
  });
});
