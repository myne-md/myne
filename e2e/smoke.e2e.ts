// Cold-boot smoke — the harness's first real scenario (task 4).
//
// Vault-count precondition: 0 (SYNC-6). An empty, isolated
// `XDG_DATA_HOME` must boot the production binary to the Welcome
// screen with no residue surfaces. Proves: driver session, per-launch
// isolation, testid selectors, artifact-on-failure, teardown.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";

describeE2E("cold-boot smoke (0 vaults)", () => {
  it("boots an empty data dir to Welcome with no residue banner", async () => {
    await scenario("smoke-cold-boot", {}, async (app) => {
      // Welcome renders (boot probe: vault_list Ok([]) + all-Empty
      // slots). byTestId throws on timeout — the await IS the assert.
      await app.session.byTestId("welcome.root", { timeoutMs: 20_000 });

      // Primary CTA present and enabled.
      const cta = await app.session.byTestId("welcome.create-cta");
      expect(await cta.enabled()).toBe(true);

      // Clean fixture ⇒ no orphan-residue banner (MYND-159 surface).
      expect(await app.session.byTestIdAll("repair-residue.banner")).toHaveLength(0);
    });
  });
});
