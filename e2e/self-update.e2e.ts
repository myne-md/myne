// su1: desktop self-update surfaces (Settings → About + the notice).
// Vault-count precondition: 1.
//
// Asserts the update controls render on the PRODUCTION binary: the update
// channel row, the "Check for updates" button and the status line, all gated on
// the `selfUpdate` capability (present on desktop), and that NO update notice is
// on screen while the host has offered nothing. It deliberately does not drive a
// real update: the check reaches `downloads.myne.md`, whose reachability from
// the container is not guaranteed, so this pins the surfaces rather than the
// network outcome, and the interactive flow (notice, confirm, the lock, the
// updating screen) stays on the gated manual roster item (`app.self-update`) for
// the same reason. The notice's own states are covered by the story catalogue
// and by `tests/components/UpdateNotice.test.tsx`, where the platform answer is
// a fixture rather than a network.
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
  it("renders the About update controls, and no notice before an update is offered", async () => {
    let seeded: SeededVault;
    await scenario(
      "su1-self-update-surfaces",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // Nothing has been offered, so neither the notice nor the pill it
        // reduces to is on screen. Both ids are asserted because they are two
        // render paths, and a regression that mounts the pill alone would slip
        // past a check for the card.
        expect(await s.byTestIdAll("update.notice")).toHaveLength(0);
        expect(await s.byTestIdAll("update.notice-pill")).toHaveLength(0);

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
