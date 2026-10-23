// The offline first run, end to end (myne-md/myne#911 task 6, story 1/3/4/9).
//
// One scenario, because the claim is one sentence: **a fresh desktop install
// reaches a working vault with no endpoint configured anywhere**, and it does it
// with ONE phrase.
//
// What makes it worth a scenario rather than unit coverage:
//
//  - the identity is created with no server. The identity's keypair derives from
//    the phrase and the frame is sealed on disk, so there is nothing to reach;
//    the old flow fronted a "choose a sync server" step here, and its absence is
//    asserted rather than assumed (`first-run-server.root` and
//    `sync.endpoint-config` must both be missing).
//  - the phrase ceremony is the IDENTITY's, and the type-back gates it. A saved
//    phrase nobody proved is the failure §7.1.3 exists for.
//  - the vault that follows has NO phrase of its own (`create.phrase-grid` must
//    never appear) and is born `NTV7`. The magic read off disk is the format's
//    end-to-end proof: it runs against the production binary through the real
//    UI, so nothing about it is seeded or mocked.
//
// The scenario does NOT save the phrase to a file: the save action opens the OS
// dialog, which this harness cannot answer, and the type-back is the gate the
// flow actually enforces.

import { expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { startFirstRunIdentity } from "./support/flows";

/** Creation runs the production Argon2id pair, plus the identity seed's own
 *  Argon2id. Budget generously: three derivations on a loaded CI box. */
const KDF_BUDGET_MS = 180_000;

const PASSWORD = "Tk9#mQ4!wX7&zR2p-fr1";

async function acknowledgeBriefing(
  app: Awaited<Parameters<Parameters<typeof scenario>[2]>>[0],
): Promise<void> {
  await app.session.byTestId("create.briefing", { timeoutMs: 15_000 });
  const cont = await app.session.byTestId("create.briefing-continue");
  const acks = await app.session.byTestIdAll("create.briefing-ack");
  expect(acks.length).toBe(3);
  for (const ack of acks) {
    await ack.click();
  }
  await app.session.waitUntil(() => cont.enabled(), {
    label: "briefing continue enabled (3/3 acknowledged)",
    timeoutMs: 10_000,
  });
  await cont.click();
}

describeE2E("first run offline (myne-md/myne#911 task 6)", () => {
  it("creates an identity with no server, then a vault with no vault phrase", async () => {
    await scenario("first-run-offline", {}, async (app) => {
      await app.session.byTestId("welcome.root", { timeoutMs: 20_000 });

      // The welcome screen offers ONE create door and asks for no endpoint.
      await app.session.byTestId("welcome.create-cta");
      expect(await app.session.byTestIdAll("first-run-server.root")).toHaveLength(0);
      expect(await app.session.byTestIdAll("sync.endpoint-config")).toHaveLength(0);

      // Identity first: phrase, then type-back. The helper asserts the reveal
      // gate and the 4-of-24 challenge; both are the identity's own ceremony.
      await startFirstRunIdentity(app.session);

      // Onboarding asked for no server at any point, including the moment the
      // identity became real on disk.
      expect(await app.session.byTestIdAll("first-run-server.root")).toHaveLength(0);
      expect(await app.session.byTestIdAll("sync.endpoint-config")).toHaveLength(0);

      // The vault follows: briefing, name, password. The briefing is still the
      // contract for the PASSWORD; the phrase it names is the identity's.
      await acknowledgeBriefing(app);
      await (await app.session.byTestId("create.name-input", { timeoutMs: 15_000 })).sendKeys(
        "Offline",
      );
      await (await app.session.byTestId("create.name-continue")).click();
      await (await app.session.byTestId("create.password-input")).sendKeys(PASSWORD);
      await (await app.session.byTestId("create.confirm-input")).sendKeys(PASSWORD);
      const submit = await app.session.byTestId("create.submit");
      await app.session.waitUntil(() => submit.enabled(), {
        label: "password submit enabled",
        timeoutMs: 15_000,
      });
      await submit.click();

      // The retirement, asserted as an ABSENCE: there is no vault phrase, so the
      // kit never mounts. Waiting for `create.ready-done` instead is what proves
      // the flow went straight through `committing` rather than stalling on a
      // screen that no longer exists.
      const done = await app.session.byTestId("create.ready-done", {
        timeoutMs: KDF_BUDGET_MS,
      });
      expect(await app.session.byTestIdAll("create.phrase-grid")).toHaveLength(0);

      // The birth format, read off disk. `NTV7` is the person-wrapped
      // generation: `root_key` sealed to the identity, roster signed, and the
      // three phrase-wrap fields structurally zero.
      const vaultsDir = join(app.appDataDir, "vaults");
      // The entry type is named rather than inferred: this tsconfig has no
      // `@types/node`, so an untyped `readdirSync` overload leaves `d` as
      // `any` and the test-typecheck budget counts it as a regression.
      const ids = readdirSync(vaultsDir, { withFileTypes: true })
        .filter((d: { isDirectory(): boolean }) => d.isDirectory())
        .map((d: { name: string }) => d.name);
      expect(ids).toHaveLength(1);
      const metaBytes = readFileSync(join(vaultsDir, ids[0], "vault.meta"));
      expect(metaBytes.subarray(0, 4).toString("latin1")).toBe("NTV7");
      // Not the 345-byte base any more: the frame is
      // `445 + roster_len + 1208`, so a length check here would be a second
      // opinion about a number task 2 owns. Assert it is NOT the base instead.
      expect(metaBytes.length).toBeGreaterThan(345);

      // Done → auto-unlock chain (production Argon2id again) → editor.
      await done.click();
      await app.session.byTestId("editor.root", { timeoutMs: KDF_BUDGET_MS });
    });
  });
});
