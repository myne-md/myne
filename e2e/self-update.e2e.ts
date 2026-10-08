// su1: desktop self-update surfaces (Settings → About + the banner).
// Vault-count precondition: 1.
//
// Asserts the update controls render on the PRODUCTION binary: the update
// channel row, the "Check for updates" button and the status line, all gated on
// the `selfUpdate` capability (present on desktop), and that the update banner
// is ABSENT while no update has been found. It deliberately does not drive a
// real update: the check reaches `downloads.myne.md`, whose reachability from
// the container is not guaranteed, so this pins the surfaces rather than the
// network outcome. The signature-gated install is the gated manual roster item
// (`app.self-update`).
//
// KDF: weak generator fixtures (unlock reads params from vault.meta).
//
// ⚠️ NEW SCENARIO: authored to the harness conventions but NOT yet validated in
// the container (this dev platform is macOS; the suite is Linux/tauri-driver
// only). Definition of done per e2e/AGENTS.md is "green 3x consecutive" via
// ./scripts/e2e-buildrun.sh. Run ISOLATED; the full suite contaminates.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import { dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";

describeE2E("su1 desktop self-update surfaces", () => {
  it("renders the About update controls, and no banner before an update is found", async () => {
    let seeded: SeededVault;
    await scenario(
      "su1-self-update-surfaces",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // No update has been found yet, so the banner is absent.
        expect(await s.byTestIdAll("update.banner")).toHaveLength(0);

        // The About panel carries the update controls (selfUpdate is present on
        // desktop). `byTestId` waits for each.
        await openSettings(s, "about");
        await s.byTestId("about.update-channel");
        await s.byTestId("about.update-check");
        await s.byTestId("about.update-status");
      },
    );
  });
});
