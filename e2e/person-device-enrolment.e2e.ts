// Person-scoped device enrolment, on two real devices (myne-md/myne#911 task 9).
//
// One scenario, because the claim is one sentence: **one code and one phrase admit
// a phone-shaped second device to the whole account, and one revocation takes it
// out of every vault.** What makes it worth a scenario rather than unit coverage:
//
//  - the code A produces and the code B pastes are the SAME bytes. B decodes a
//    payload that carries only A's person id (public material), and B's own
//    phrase must derive exactly that id or the join is refused as a mismatch.
//  - B lands PENDING. Nothing B does before A approves can give it a vault, and
//    the assertion for that is the pending screen itself plus the fact that B has
//    no vault directory yet.
//  - after approval B finishes on its own (no second phrase), LISTS the account's
//    vaults, and the vault it now holds opens with ITS OWN PASSWORD. That is the
//    1B shape: the device lists every vault, each opens with its own password.
//  - A removes B, and B's next sync is refused. "One revocation covers every
//    vault" is only meaningful if the device actually stops, so the sync is the
//    assertion rather than the roster row disappearing.
//
// Two devices, one ephemeral server. A creates its own identity and vault on the
// first run (vault-count 1); B joins from a fresh install (vault-count 0).

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import { withTwoDevices } from "./support/multi-device";
import { harnessSupported } from "./support/session";
import {
  clickByTestId,
  closeSettings,
  dismissImporterOffer,
  ipcOk,
  openSettings,
  registerPersonIdentity,
  selectSettingsTopic,
  startFirstRunIdentity,
} from "./support/flows";

const ready = harnessSupported().ok && syncServerSupported().ok;
const describeDevice = ready ? describe : describe.skip;

/** Creation runs three Argon2id derivations on B's join and A's first run. */
const KDF_BUDGET_MS = 180_000;
const VAULT_PASSWORD = "Tk9#mQ4!wX7&zR2p-join9";

/** Every vault directory under the app data dir, and their frames. */
function vaultDirs(appDataDir: string): string[] {
  const dir = join(appDataDir, "vaults");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d: { isDirectory(): boolean }) => d.isDirectory())
    .map((d: { name: string }) => join(dir, d.name));
}

function syncState(appDataDir: string): Record<string, unknown> | null {
  const dirs = vaultDirs(appDataDir);
  if (dirs.length !== 1) return null;
  const path = join(dirs[0], "sync-state.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describeDevice("person-scoped device enrolment (myne-md/myne#911 task 9)", () => {
  it("admits a second device with one code and the phrase, then revokes it everywhere", async () => {
    const srv = await startSyncServer();
    try {
      await withTwoDevices(srv, async (a, b) => {
        // ── A: identity, vault, publish ──────────────────────────────────────
        await a.session.byTestId("welcome.root", { timeoutMs: 20_000 });
        const phrase = await startFirstRunIdentity(a.session);
        await a.session.byTestId("create.briefing", { timeoutMs: 15_000 });
        const briefingContinue = await a.session.byTestId("create.briefing-continue");
        for (const ack of await a.session.byTestIdAll("create.briefing-ack")) {
          await ack.click();
        }
        await a.session.waitUntil(() => briefingContinue.enabled(), {
          label: "briefing continue enabled",
          timeoutMs: 10_000,
        });
        await briefingContinue.click();
        await (await a.session.byTestId("create.name-input", { timeoutMs: 15_000 })).sendKeys(
          "Joined",
        );
        await (await a.session.byTestId("create.name-continue")).click();
        await (await a.session.byTestId("create.password-input")).sendKeys(VAULT_PASSWORD);
        await (await a.session.byTestId("create.confirm-input")).sendKeys(VAULT_PASSWORD);
        await clickByTestId(a.session, "create.submit", { timeoutMs: 15_000 });
        await clickByTestId(a.session, "create.ready-done", { timeoutMs: KDF_BUDGET_MS });
        await a.session.byTestId("editor.root", { timeoutMs: KDF_BUDGET_MS });
        await dismissImporterOffer(a.session);

        // REGISTER first: publishing is under a NAMED server account and refuses
        // with "Register your identity first" until the identity's public halves
        // are written there and this device holds a token. Registration became an
        // explicit act on 2026-10-24 (the server is a decision that belongs before
        // any secret is typed); see `registerPersonIdentity`.
        await registerPersonIdentity(a.session, phrase);

        // Publishing then works with the identity LOCKED: the PUT authenticates
        // with the device token on disk, and the B vaults only need the frame on
        // the server to be findable.
        await openSettings(a.session, "sync");
        // The publish row lives in the CONNECTION topic since 2026-10-25 (it is an
        // identity act, and "Enrolled devices" over it read as a device operation).
        await selectSettingsTopic(a.session, "sync", "connection");
        await clickByTestId(a.session, "sync.panel.publish", { timeoutMs: 20_000 });
        await a.session.waitUntil(
          async () =>
            (await (await a.session.byTestId("sync.panel.publish-state")).textContent()).includes(
              "on your sync server",
            )
              ? true
              : null,
          { label: "A's vault published", timeoutMs: 40_000 },
        );

        // The owner's code names the PERSON, and the dialog is the real surface
        // a user reaches it through.
        const qr = (await ipcOk(a.session, "plugin:sync|sync_person_join_qr", {})) as {
          payload: string;
          svg: string;
        };
        expect(qr.payload.startsWith(`MYQR3|p|${srv.url}|`)).toBe(true);
        expect(qr.svg.length).toBeGreaterThan(0);
        // The QR icon is an icon in the DEVICES section's header, and the publish
        // above left Settings on CONNECTION — so the control was not in the tree
        // at all and the click reported "nothing matches that selector", which
        // reads as a missing affordance rather than as the other topic.
        await selectSettingsTopic(a.session, "sync", "devices");
        await clickByTestId(a.session, "sync.device-join-qr.open", { timeoutMs: 20_000 });
        // The PERSON variant, not the account-number one: this vault has no
        // account number, and the dialog picks the variant from the vault's
        // generation rather than from a prop the caller could get wrong.
        await a.session.byTestId("sync.person-join-qr.dialog", { timeoutMs: 15_000 });
        await a.session.byTestId("sync.person-join-qr", { timeoutMs: 15_000 });
        // The dialog is a modal OVER Settings, so its own × has to close it
        // before Settings' × is reachable at all.
        await clickByTestId(a.session, "sync.person-join-qr.dialog-close", { timeoutMs: 10_000 });
        await closeSettings(a.session);

        // ── B: code, phrase, pending ─────────────────────────────────────────
        await b.session.byTestId("welcome.root", { timeoutMs: 20_000 });
        await clickByTestId(b.session, "welcome.join-cta", { timeoutMs: 15_000 });
        await b.session.byTestId("join.modal", { timeoutMs: 10_000 });
        await clickByTestId(b.session, "join.code-open", { timeoutMs: 10_000 });
        await (await b.session.byTestId("join.code-input", { timeoutMs: 10_000 })).replaceText(
          qr.payload,
        );
        await clickByTestId(b.session, "join.code-submit", { timeoutMs: 15_000 });
        try {
          await b.session.byTestId("join.person-phrase", { timeoutMs: 15_000 });
        } catch (e) {
          // The code step's only other outcome is a refusal banner, and the
          // message is what says WHICH refusal. Without it a timeout here reads
          // as a missing screen rather than as an answer.
          const seen = await b.session.execute<string>("return document.body.innerText;");
          throw new Error(`the code was refused. Screen:\n${seen}`);
        }
        for (const [index, word] of phrase.entries()) {
          const cells = await b.session.byTestIdAll("join.person-phrase-cell");
          await cells[index].replaceText(word);
        }
        await clickByTestId(b.session, "join.person-phrase-submit", { timeoutMs: 90_000 });
        await b.session.byTestId("join.person-pending", { timeoutMs: 90_000 });
        // Nothing can have landed on B yet: the approval has not happened.
        expect(vaultDirs(b.appDataDir)).toHaveLength(0);

        // ── A: approve once ──────────────────────────────────────────────────
        await openSettings(a.session, "sync");
        await selectSettingsTopic(a.session, "sync", "devices");
        await clickByTestId(a.session, "sync.approve-device", { timeoutMs: 45_000 });
        await closeSettings(a.session);

        // ── B: finishes itself, lists the vault, opens it with its password ──
        await b.session.byTestId("unlock.password-input", { timeoutMs: 120_000 });
        const listed = vaultDirs(b.appDataDir);
        expect(listed).toHaveLength(1);
        const frame = readFileSync(join(listed[0], "vault.meta"));
        // `NTV8`: the frame B received from the server is the password-only
        // generation, which is the point of the join. B holds no phrase for this
        // vault and needs none: it opens with the vault password, and the
        // identity phrase it typed above proved WHO it is
        // (myne-md/myne#938, `decisions/protocol/0758`).
        expect(frame.subarray(0, 4).toString("latin1")).toBe("NTV8");
        expect(typeof syncState(b.appDataDir)?.namespace_hex).toBe("string");

        await (await b.session.byTestId("unlock.password-input")).sendKeys(VAULT_PASSWORD);
        await clickByTestId(b.session, "unlock.submit", { timeoutMs: KDF_BUDGET_MS });
        await b.session.byTestId("editor.root", { timeoutMs: KDF_BUDGET_MS });
        await dismissImporterOffer(b.session);

        // ── A: one revocation ────────────────────────────────────────────────
        await openSettings(a.session, "sync");
        await selectSettingsTopic(a.session, "sync", "devices");
        // The current device's row carries no Remove button, so the only one on
        // screen belongs to the device just approved.
        const removeButtons = await a.session.byTestIdAll("sync.remove-device");
        expect(removeButtons).toHaveLength(1);
        await removeButtons[0].click();
        await clickByTestId(a.session, "sync.remove-confirm-yes", { timeoutMs: 15_000 });
        await closeSettings(a.session);

        // ── B: every vault refuses it ────────────────────────────────────────
        // The cycle is the assertion: a revoked device must not be able to sync
        // the vault it just opened, and the failure is a real answer rather than
        // a hang (the removed device is told the owner removed it, not that its
        // sign-in is wrong).
        const status = (await ipcOk(b.session, "plugin:sync|sync_now", {})) as {
          state: string;
          detail?: string;
        };
        expect(status.state).toBe("error");

        // The vault is still a local vault: revocation removes ACCESS, never the
        // user's notes on the device.
        await b.session.byTestId("editor.root", { timeoutMs: 15_000 });
      });
    } finally {
      await srv.teardown();
    }
  });
});
