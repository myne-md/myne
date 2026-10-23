// Publishing a vault to the server (myne-md/myne#911 task 8, stories 13/14/23).
//
// Three scenarios, because "published" is three different claims and each one can
// be false on its own:
//
//  1. A vault born under an identity publishes, and the metadata really lands in
//     the namespace the client recorded. Asserted from BOTH ends: the panel reads
//     "published" out of its own durable record, and an unauthenticated GET of
//     `/vault.meta?account=<namespace>` returns that vault's `NTV7` frame. The
//     server binding the owner on its first write is what makes the second one
//     possible, so the fetch is the end-to-end proof rather than a second read of
//     local state.
//     It also proves the ENGINE half: after a publish, one ordinary `sync_now`
//     completes a cycle. Before this change the cycle refused a person-born vault
//     outright (it demanded an enrolment record such a vault cannot have), so a
//     published vault was reachable and un-syncable.
//  2. A publish that cannot reach the server leaves the vault exactly as it was,
//     and a retry completes once the cause is fixed. The retry is driven through
//     the real Settings endpoint field, which is what a user does about it.
//  3. A legacy vault publishes through its OWN credential path, with no identity
//     on the device at all. This is the half a person-token-only implementation
//     would quietly break, and it is exercised over a real enrolment: the token
//     that authorizes the PUT is the vault account's.
//
// What is NOT proved here, and cannot be: "publishes and opens on a second
// device". Opening it elsewhere is the person-scoped device-add flow (task 9), so
// nothing in this file claims it.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scenario } from "./support/scenario";
import { harnessSupported } from "./support/session";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import { syncConfigSeed, setupTwoSyncedDevices } from "./support/multi-device";
import {
  clickByTestId,
  closeSettings,
  dismissImporterOffer,
  openSettings,
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

describePublish("publish a vault (myne-md/myne#911 task 8)", () => {
  it("publishes a person-born vault, and the metadata lands in its namespace", async () => {
    const srv = await startSyncServer();
    try {
      await scenario(
        "publish-vault-person",
        { seedConfig: syncConfigSeed(srv.url) },
        async (app) => {
          const phrase = await createIdentityAndVault(app);

          await openSettings(app.session, "sync");
          await selectSettingsTopic(app.session, "sync", "devices");

          // Device only, before anything is pressed. The row's own state line is
          // read from disk, so this is the durable answer and not this session's.
          const state = await app.session.byTestId("sync.panel.publish-state", {
            timeoutMs: 15_000,
          });
          expect(await state.textContent()).toContain("exists only on this device");

          // A person-born vault has no vault account, so the legacy "add this
          // device" form (account number + password) must not be offered here.
          expect(await app.session.byTestIdAll("sync.enroll")).toHaveLength(0);

          await clickByTestId(app.session, "sync.panel.publish", { timeoutMs: 20_000 });
          await app.session.waitUntil(
            async () =>
              (await (await app.session.byTestId("sync.panel.publish-state")).textContent()).includes(
                "on your sync server",
              ),
            { label: "publish reported as done", timeoutMs: 30_000 },
          );

          // The recorded namespace, off disk, is what the request named.
          const recorded = readSyncState(app.appDataDir);
          const namespace = recorded.namespace_hex;
          expect(typeof namespace).toBe("string");
          expect(recorded.published_at_ms).toBeTypeOf("number");

          // The server end: an unauthenticated fetch of that namespace answers
          // with this vault's frame. `NTV7` pins that what was uploaded is the
          // person-wrapped generation rather than a legacy meta blob.
          const resp = await fetch(`${srv.url}/vault.meta?account=${String(namespace)}`);
          expect(resp.status).toBe(200);
          const body = new Uint8Array(await resp.arrayBuffer());
          expect(Buffer.from(body.subarray(0, 4)).toString("latin1")).toBe("NTV7");

          // The engine half. A published person-born vault must actually run a
          // cycle: it has no enrolment record, so the pre-fix cycle refused it at
          // `NotReady` and the vault was reachable but un-syncable. Two things have
          // to be true for that: the status indicator must stop calling the vault
          // "not enrolled" (which also re-offers the manual trigger), and a cycle
          // must then complete, which is what stamps `last_success_at_ms`.
          // On the CONNECTION topic, because that is the body the indicator
          // lives in and only the active topic is mounted. The status has to
          // read enrolled there, which it can only do from the publish record
          // (a person-born vault has no enrolment of its own) and is why this
          // is an assertion rather than a lane into another sync.
          //
          // Publishing worked with the identity LOCKED, and that is the correct
          // split rather than an accident: the PUT authenticates with the device
          // token on disk, while signing a head needs the keypair in RAM. So the
          // identity is unlocked here, with the phrase, before the cycle runs.
          await unlockIdentity(app, phrase);
          const syncNow = await app.session.byTestId("sync.sync-now", { timeoutMs: 30_000 });
          await syncNow.click();
          let stamped: unknown = undefined;
          for (let i = 0; i < 30 && stamped == null; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            stamped = readSyncState(app.appDataDir).last_success_at_ms;
          }
          expect(stamped).toBeTypeOf("number");

          // Durable across the panel's own lifetime: closing Settings unmounts
          // the panel, so the reopened row can only have come from disk.
          await closeSettings(app.session);
          await openSettings(app.session, "sync");
          await selectSettingsTopic(app.session, "sync", "devices");
          const reopened = await app.session.byTestId("sync.panel.publish-state", {
            timeoutMs: 15_000,
          });
          expect(await reopened.textContent()).toContain("on your sync server");
        },
      );
    } finally {
      await srv.teardown();
    }
  });

  it("leaves the vault intact when the server cannot be reached, and a retry completes", async () => {
    const srv = await startSyncServer();
    try {
      // Boot against the LIVE server, because that is what issues the identity's
      // device token: the first run registers the identity when a server answers
      // (an offline first run stays `reserved`, and a reserved identity has
      // nothing to publish under). Getting a token is therefore not something
      // this scenario can skip to.
      await scenario("publish-vault-down", { seedConfig: syncConfigSeed(srv.url) }, async (app) => {
        await createIdentityAndVault(app);

        // Break the connection the way a user does: point the endpoint at a port
        // nothing listens on. Port 9 is the discard port, so the attempt is
        // strictly refused rather than left hanging. Saving an `http` loopback
        // URL performs no TLS probe, so this both persists and leaves the token
        // it was issued alone.
        await openSettings(app.session, "sync");
        await selectSettingsTopic(app.session, "sync", "connection");
        const field = await app.session.byTestId("sync.endpoint-input", { timeoutMs: 15_000 });
        await field.replaceText("http://127.0.0.1:9");
        await clickByTestId(app.session, "sync.endpoint-connect", { timeoutMs: 30_000 });

        await selectSettingsTopic(app.session, "sync", "devices");
        await clickByTestId(app.session, "sync.panel.publish", { timeoutMs: 20_000 });
        await app.session.waitUntil(
          async () =>
            (await (await app.session.byTestId("sync.panel.publish-state")).textContent()).includes(
              "Could not reach the server",
            )
              ? true
              : null,
          { label: "the refused publish is reported, not swallowed", timeoutMs: 75_000 },
        );

        // Nothing was recorded, so the retry is a FIRST attempt rather than a
        // resume of half-written state. This is the "deliberately no rollback"
        // claim, measured: the namespace field is absent, not restored.
        expect(readSyncState(app.appDataDir).namespace_hex ?? null).toBeNull();

        // The vault is still a working vault while all of that failed.
        await closeSettings(app.session);
        await app.session.byTestId("editor.root", { timeoutMs: 15_000 });

        // The cause, fixed the way a user fixes it: point the endpoint back.
        await openSettings(app.session, "sync");
        await selectSettingsTopic(app.session, "sync", "connection");
        const again = await app.session.byTestId("sync.endpoint-input", { timeoutMs: 15_000 });
        await again.replaceText(srv.url);
        await clickByTestId(app.session, "sync.endpoint-connect", { timeoutMs: 30_000 });

        await selectSettingsTopic(app.session, "sync", "devices");
        await clickByTestId(app.session, "sync.panel.publish", { timeoutMs: 20_000 });
        await app.session.waitUntil(
          async () =>
            (await (await app.session.byTestId("sync.panel.publish-state")).textContent()).includes(
              "on your sync server",
            )
              ? true
              : null,
          { label: "the retry completes once the server is reachable", timeoutMs: 40_000 },
        );
        expect(typeof readSyncState(app.appDataDir).namespace_hex).toBe("string");
      });
    } finally {
      await srv.teardown();
    }
  });

  it("publishes a legacy vault through its own credential, with no identity", async () => {
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
      await selectSettingsTopic(a.session, "sync", "devices");
      // Enrolled, so its own token already puts it on the server.
      const line = await a.session.byTestId("sync.panel.publish-state", { timeoutMs: 15_000 });
      expect(await line.textContent()).toContain("on your sync server");

      // Pressing it re-asserts the metadata; the point is that it SUCCEEDS with a
      // vault token and no person session anywhere on the device.
      await clickByTestId(a.session, "sync.panel.publish", { timeoutMs: 20_000 });
      await a.session.waitUntil(
        async () =>
          (await (await a.session.byTestId("sync.panel.publish-state")).textContent()).includes(
            "on your sync server",
          ),
        { label: "a legacy vault publishes on its own credential", timeoutMs: 40_000 },
      );
      // And the vault did not lose its own addressing: a legacy publish records
      // the act but never a namespace, because its credential already names one.
      const recorded = readSyncState(a.appDataDir);
      expect(recorded.namespace_hex ?? null).toBeNull();
    } finally {
      await teardown();
      await srv.teardown();
    }
  });
});
