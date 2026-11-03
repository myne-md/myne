// Browser-clipper host-install toggle suite (installer wiring, decisions.md
// 2026-07-05; default flipped to OFF by MYND-549). Drives Settings → Browser
// extensions → "Browser clipper" through the REAL editor UI on the tauri-driver
// harness.
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

// QUARANTINE (contention): tail-of-suite mount-timeout — never reaches the
// unlock screen within budget on a contended runner. Green 3× on 2026-07-26;
// regressed under suite-length degradation, not a clipper logic bug. Debt:
// pay down via the boot-cost investigation (same family as nav1/tp1).
// DE-QUARANTINED (myne-md/myne#555). The quarantine reason was
// runner contention, and it was wrong for the same reason it was wrong for
// `nav1`: the first seeding test in a vitest process builds `e2e-fixture-gen`
// with `cargo build --release` INSIDE its own budget, ~171 s against a 180 s
// `testTimeout`. Which spec paid it depended only on which one seeded first,
// which is why the victim moved between runs and read as a loaded host.
// `e2e/support/global-setup.ts` now pays that build once per vitest invocation,
// before any worker starts. Measured after the fix, `--retry=0`, warm
// container: 16 consecutive clean runs, which is the bar `e2e/AGENTS.md` sets.
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

        // Settings → Browser extensions hosts the toggle since myne-md/myne#960,
        // where the clipper left the Account panel.
        await openSettings(s, "extensions");
        await s.byTestId("settings.clipper-install");

        // Default: absent flag ⇒ NOT registered ⇒ toggle OFF (MYND-549).
        await waitEnabled(s, "false");

        // Flip ON — writes the flag + installs the manifests, returns enabled=true.
        // Centre the toggle first: a settings panel scrolls and this row can sit
        // below its fold, where W3C `/click`'s scroll-into-view under
        // WebKitGTK leaves it reporting "element not interactable" forever.
        // Same discipline as `pickSelect` / `enableDeveloperModeInSettings`.
        await (await s.byTestId("settings.clipper-install-toggle")).scrollIntoView();
        await (await s.byTestId("settings.clipper-install-toggle")).click();
        await waitEnabled(s, "true");

        // Flip back OFF — removes the manifests, returns enabled=false.
        await (await s.byTestId("settings.clipper-install-toggle")).scrollIntoView();
        await (await s.byTestId("settings.clipper-install-toggle")).click();
        await waitEnabled(s, "false");

        await closeSettings(s);
      },
    );
  });
});
