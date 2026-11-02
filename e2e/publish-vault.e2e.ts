// A vault publishing itself to the server (myne-md/myne#911 task 8, #974).
//
// Publishing used to be a button, and the button was the only door: the command
// had one call site, so a user who never found the row sat on a vault their other
// devices could not see. It is now the sync cycle's job, taken the first time it
// has an endpoint, a registered identity and a person session
// (`core/src/plugins/sync/publish.rs::publish_if_due`). Two scenarios, because
// "published" is now two different claims and each one can be false on its own:
//
//  1. A vault born under an identity is published with NOTHING PRESSED, and the
//     metadata really lands in the namespace the client recorded. Asserted from
//     BOTH ends: the durable record on disk, and an unauthenticated GET of
//     `/vault.meta?account=<namespace>` returning that vault's `NTV8` frame. The
//     server binding the owner on its first write is what makes the second one
//     possible, so the fetch is the end-to-end proof rather than a second read of
//     local state. It also proves the ENGINE half: after publishing, one ordinary
//     `sync_now` completes a cycle.
//  2. A legacy enrolled vault is NEVER published by the cycle, and records no
//     namespace: its own credential already names one, so taking the person arm
//     would switch it onto a credential it does not have.
//
// WHAT THIS FILE NO LONGER COVERS, stated rather than implied. Two scenarios went
// with the button. "A publish that cannot reach the server leaves the vault
// intact, and a retry completes" is now unreachable from the UI: there is no
// press to fail, the attempt belongs to the loop, and a transport failure surfaces
// as the ordinary sync-status error that other scenarios already drive. The
// no-rollback contract itself is held in `core/src/plugins/sync/publish.rs`, where
// the failure paths are unit-testable without a server. And "a legacy vault
// publishes through its own credential" lost its subject with the button: what
// remains of that claim is the negative above plus
// `publish_is_not_due_for_a_legacy_vault`.
//
// What is NOT proved here, and cannot be: "publishes and opens on a second
// device". Opening it elsewhere is the person-scoped device-add flow (task 9), so
// nothing in this file claims it.
//
// **And the register-from-Settings door is not drivable here, stated rather than
// faked (2026-10-23).** It renders only for a `reserved` identity, and this
// harness cannot construct "reserved identity plus a vault": the first run enrols
// the identity whenever a server answers, while a vault cannot be created without
// an endpoint. An offline first run stays reserved but never reaches a vault. The
// flow is covered at the unit tier instead, where the state is a prop:
// `tests/components/personRegisterForm.test.tsx` and the Settings mount in
// `tests/components/SyncPanel.identity-block.test.tsx`.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scenario } from "./support/scenario";
import { harnessSupported } from "./support/session";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import { syncConfigSeed, setupTwoSyncedDevices } from "./support/multi-device";
import {
  clickByTestId,
  dismissImporterOffer,
  openSettings,
  registerPersonIdentity,
  selectSettingsTopic,
  startFirstRunIdentity,
} from "./support/flows";

/** Two Argon2id derivations (identity seed + vault password) per creation. */
const KDF_BUDGET_MS = 180_000;
const PASSWORD = "Tk9#mQ4!wX7&zR2p-pub8";

const server = syncServerSupported();
const driver = harnessSupported();
const ready = driver.ok && server.ok;
if (!ready) {
  // One honest reason line, so a filtered run explains itself rather than
  // reporting three green scenarios that asserted nothing.
  // eslint-disable-next-line no-console
  console.warn(
    `[e2e] publish-vault skipped: ${!driver.ok ? driver.reason : server.reason}`,
  );
}

const describePublish = ready ? describe : describe.skip;

/**
 * The single discovered vault's `sync-state.json`, parsed.
 *
 * Tolerant of ABSENCE on purpose: creation writes no sync state at all, so
 * "before publish" is an empty object rather than an error. A reader that threw
 * here would make the failed-publish assertion test the fixture instead.
 */
function readSyncState(appDataDir: string): Record<string, unknown> {
  const vaultsDir = join(appDataDir, "vaults");
  const ids = readdirSync(vaultsDir, { withFileTypes: true })
    .filter((d: { isDirectory(): boolean }) => d.isDirectory())
    .map((d: { name: string }) => d.name);
  expect(ids).toHaveLength(1);
  const path = join(vaultsDir, ids[0], "sync-state.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * Wait for the CYCLE to publish, and answer the recorded state once it has.
 *
 * No click exists to drive this, so the only honest signal is the durable record:
 * `publish_vault` writes `namespace_hex` and `published_at_ms` in one atomic state
 * write, and nothing else in the product writes a namespace for a person-born
 * vault. The budget covers two poll intervals (30s each) plus the round trip,
 * because the trigger is the loop rather than a press.
 */
async function waitForPublish(
  app: Awaited<Parameters<Parameters<typeof scenario>[2]>>[0],
  timeoutMs: number,
): Promise<{ namespace_hex?: unknown; published_at_ms?: unknown }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = readSyncState(app.appDataDir);
    if (typeof state.namespace_hex === "string") return state;
    if (Date.now() > deadline) {
      throw new Error(
        `the vault was never published: sync-state.json still has no namespace after ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/**
 * Walk the first run to a working editor: identity, then the vault. Returns the
 * identity's 24 words, which the sync half needs: the person keypair is
 * session-scoped (decision 0612), so unlocking the vault a moment later drops it
 * and authoring a signed head asks for the phrase again.
 */
async function createIdentityAndVault(
  app: Awaited<Parameters<Parameters<typeof scenario>[2]>>[0],
): Promise<string[]> {
  await app.session.byTestId("welcome.root", { timeoutMs: 20_000 });
  const phrase = await startFirstRunIdentity(app.session);
  await app.session.byTestId("create.briefing", { timeoutMs: 15_000 });
  const cont = await app.session.byTestId("create.briefing-continue");
  const acks = await app.session.byTestIdAll("create.briefing-ack");
  for (const ack of acks) {
    await ack.click();
  }
  await app.session.waitUntil(() => cont.enabled(), {
    label: "briefing continue enabled",
    timeoutMs: 10_000,
  });
  await cont.click();
  await (await app.session.byTestId("create.name-input", { timeoutMs: 15_000 })).sendKeys("Published");
  await (await app.session.byTestId("create.name-continue")).click();
  await (await app.session.byTestId("create.password-input")).sendKeys(PASSWORD);
  await (await app.session.byTestId("create.confirm-input")).sendKeys(PASSWORD);
  await clickByTestId(app.session, "create.submit", { timeoutMs: 15_000 });
  await clickByTestId(app.session, "create.ready-done", { timeoutMs: KDF_BUDGET_MS });
  await app.session.byTestId("editor.root", { timeoutMs: KDF_BUDGET_MS });
  // A fresh vault opens with the importer offer over the editor, and its backdrop
  // swallows the click on the Settings gear. Dismissing it is what every suite
  // that reaches Settings from a created vault does.
  await dismissImporterOffer(app.session);
  return phrase;
}

/**
 * Unlock the identity for this session, through the panel's own inline phrase
 * entry (myne-md/myne#831). This is the remedy the app offers for
 * `identity_locked`, and it is a step a user performs rather than a test hook:
 * the keypair that signs a head is only held while the identity is unlocked.
 */
async function unlockIdentity(
  app: Awaited<Parameters<Parameters<typeof scenario>[2]>>[0],
  words: readonly string[],
): Promise<void> {
  await selectSettingsTopic(app.session, "sync", "connection");
  // IDEMPOTENT, because REGISTERING already unlocked the identity for this
  // session: the register dialog asks for the phrase as proof, so the unlock door
  // is gone by the time this runs and a blind click waited its whole budget on a
  // control the product had correctly removed. Measured 2026-10-24, in isolation.
  if ((await app.session.byTestIdAll("sync.panel.identity-unlocked")).length > 0) return;
  await clickByTestId(app.session, "sync.panel.identity-unlock.open", { timeoutMs: 15_000 });
  for (const [index, word] of words.entries()) {
    const testId =
      index === 0
        ? "sync.panel.identity-unlock.phrase-input"
        : `sync.panel.identity-unlock.phrase-cell-${index + 1}`;
    await (await app.session.byTestId(testId)).replaceText(word);
  }
  await clickByTestId(app.session, "sync.panel.identity-unlock.submit", { timeoutMs: 20_000 });
  await app.session.byTestId("sync.panel.identity-unlocked", { timeoutMs: 30_000 });
}

describePublish("a vault publishes itself (myne-md/myne#911 task 8, #974)", () => {
  it("puts a person-born vault on the server with nothing pressed", async () => {
    const srv = await startSyncServer();
    try {
      await scenario(
        "publish-vault-person",
        { seedConfig: syncConfigSeed(srv.url) },
        async (app) => {
          const phrase = await createIdentityAndVault(app);

          // The identity exists on this device; it is not REGISTERED with the
          // server, and a person-born vault can only be published under a
          // registered identity. Registration is therefore the last act the user
          // performs before the vault stops being local-only, and it is the one
          // this scenario delegates to the product.
          await registerPersonIdentity(app.session, phrase);

          await openSettings(app.session, "sync");
          await selectSettingsTopic(app.session, "sync", "connection");

          // A person-born vault has no vault account, so the legacy "add this
          // device" form (account number + password) must not be offered here.
          expect(await app.session.byTestIdAll("sync.enroll")).toHaveLength(0);

          // **Nothing is clicked from here until the assertion.** Publishing is
          // the cycle's job now (`publish_if_due`), so what this waits on is the
          // DURABLE record on disk, which only a real cycle can write. The budget
          // is two poll intervals (30s each) plus the round trip, because the
          // trigger is the loop rather than a press.
          const recorded = await waitForPublish(app, 90_000);
          expect(recorded.published_at_ms).toBeTypeOf("number");

          // The control is GONE, and it is gone for a reason rather than hidden:
          // no press exists that could have produced the record above.
          expect(await app.session.byTestIdAll("sync.panel.publish")).toHaveLength(0);

          // The server end: an unauthenticated fetch of that namespace answers
          // with this vault's frame. `NTV8` pins that what was uploaded is the
          // password-only B2B generation rather than a legacy meta blob, and that
          // the published frame is the one creation wrote (myne-md/myne#938,
          // `decisions/protocol/0758`).
          const resp = await fetch(`${srv.url}/vault.meta?account=${String(recorded.namespace_hex)}`);
          expect(resp.status).toBe(200);
          const body = new Uint8Array(await resp.arrayBuffer());
          expect(Buffer.from(body.subarray(0, 4)).toString("latin1")).toBe("NTV8");

          // The engine half. A published person-born vault must actually run a
          // cycle: it has no enrolment record, so the pre-fix cycle refused it at
          // `NotReady` and the vault was reachable but un-syncable. Signing a head
          // needs the keypair in RAM, so the identity is unlocked here first.
          await unlockIdentity(app, phrase);
          const syncNow = await app.session.byTestId("sync.sync-now", { timeoutMs: 30_000 });
          await syncNow.click();
          let stamped: unknown = undefined;
          for (let i = 0; i < 60 && stamped == null; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            stamped = readSyncState(app.appDataDir).last_success_at_ms;
          }
          expect(stamped).toBeTypeOf("number");
        },
      );
    } finally {
      await srv.teardown();
    }
  });

  it("never records a namespace for a legacy enrolled vault", async () => {
    const srv = await startSyncServer();
    let teardown = async (): Promise<void> => {};
    try {
      // Two devices, because that is how a legacy vault account is really
      // enrolled: A enrolls on the vault account, B joins and is approved. A
      // holds NO person identity, which is the fact this scenario is about.
      const fleet = await setupTwoSyncedDevices(srv, { seedNote: false });
      teardown = fleet.teardown;
      const a = fleet.a;

      await openSettings(a.session, "sync");
      await selectSettingsTopic(a.session, "sync", "connection");
      // The publish control is absent for EVERY generation, so a legacy device
      // cannot reach a path that would switch it onto the person credential.
      expect(await a.session.byTestIdAll("sync.panel.publish")).toHaveLength(0);

      // And the automatic path refuses it: a legacy vault's namespace is its own
      // account, which its credential already names, so `publish_if_due` answers
      // "not due" and `publish_vault` records nothing. A namespace here would
      // mean the cycle had taken the person arm for a vault that has no person.
      await a.session.byTestId("sync.status-indicator", { timeoutMs: 20_000 });
      const syncNow = await a.session.byTestId("sync.sync-now", { timeoutMs: 30_000 });
      await syncNow.click();
      await new Promise((r) => setTimeout(r, 5_000));
      expect(readSyncState(a.appDataDir).namespace_hex ?? null).toBeNull();
    } finally {
      await teardown();
      await srv.teardown();
    }
  });
});
