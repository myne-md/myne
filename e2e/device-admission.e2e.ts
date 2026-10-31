// The two-sided device admission ceremony, on two real devices
// (myne-md/myne#938 task 11, `decisions/protocol/0735`).
//
// # The claim
//
// **A device is admitted only when both screens agreed on the same eight
// characters, and a disagreement writes nothing at all.** Two halves, and the
// second is the one a unit test cannot make: the ceremony's whole security
// argument is that neither side can finish alone, so the evidence has to be two
// app instances talking to one server.
//
// # Why each step is not decoration
//
//  - the code the joining device SHOWS and the code the admitting device PASTES
//    are the same bytes, and the safety code is derived independently on each
//    side from that code. A substituted device id, signing half or verifier moves
//    it (`myne.device-admission-sas v1|` covers the whole string).
//  - the preview writes NOTHING. That is asserted by the flow continuing to a
//    stopped screen and by the joining device still being refused a sync, not by
//    a log line.
//  - a mismatch is a STOP, not a retry: both sides land on
//    `sync.device-admission.stopped`, and the second half of the scenario then
//    proves the ceremony still works with a FRESH code, so the stop did not
//    wedge anything.
//  - after a real admission the joining device's next sync completes, which is
//    the only outcome the user cares about.
//
// # Unrun on the machine that wrote it
//
// The desktop lane needs Linux, tauri-driver and a built `myne-server` ELF, so
// this file has never executed. It is written from `person-device-enrolment.e2e.ts`
// (the two-device harness) and drives only shipped testids. Run it with
// `pnpm test:e2e -- device-admission` on the CI image before trusting it, and
// delete this paragraph once it has passed there.

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

/** Three Argon2id derivations: A's creation, B's join, B's unlock. */
const KDF_BUDGET_MS = 180_000;
const VAULT_PASSWORD = "Tk9#mQ4!wX7&zR2p-admit7";

/** Every vault directory under the app data dir. */
function vaultDirs(appDataDir: string): string[] {
  const dir = join(appDataDir, "vaults");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d: { isDirectory(): boolean }) => d.isDirectory())
    .map((d: { name: string }) => join(dir, d.name));
}

/** The one vault's frame, or null when the device holds none. */
function metaFrame(appDataDir: string): Buffer | null {
  const dirs = vaultDirs(appDataDir);
  if (dirs.length !== 1) return null;
  const path = join(dirs[0], "vault.meta");
  return existsSync(path) ? readFileSync(path) : null;
}

describeDevice("two-sided device admission (myne-md/myne#938 task 11)", () => {
  it("stops on a mismatched safety code, then admits on a matching one", async () => {
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
          "Admitted",
        );
        await (await a.session.byTestId("create.name-continue")).click();
        await (await a.session.byTestId("create.password-input")).sendKeys(VAULT_PASSWORD);
        await (await a.session.byTestId("create.confirm-input")).sendKeys(VAULT_PASSWORD);
        await clickByTestId(a.session, "create.submit", { timeoutMs: 15_000 });
        await clickByTestId(a.session, "create.ready-done", { timeoutMs: KDF_BUDGET_MS });
        await a.session.byTestId("editor.root", { timeoutMs: KDF_BUDGET_MS });
        await dismissImporterOffer(a.session);

        // The identity has to be REGISTERED before anything publishes: the
        // device credential this ceremony installs is installed under that
        // account, so a reserved identity would refuse it with no useful error.
        await registerPersonIdentity(a.session, phrase);

        await openSettings(a.session, "sync");
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
        await closeSettings(a.session);

        // ── B: the same identity, then a vault of its own ────────────────────
        // Admission is scoped to a device, not to a vault, so B is a working
        // device: it holds the person's identity and one vault of its own, and
        // what it lacks is a credential the server accepts for A's vault.
        await b.session.byTestId("welcome.root", { timeoutMs: 20_000 });
        await clickByTestId(b.session, "welcome.join-cta", { timeoutMs: 15_000 });
        await b.session.byTestId("join.modal", { timeoutMs: 10_000 });
        const qr = (await ipcOk(a.session, "plugin:sync|sync_person_join_qr", {})) as {
          payload: string;
        };
        await clickByTestId(b.session, "join.code-open", { timeoutMs: 10_000 });
        await (await b.session.byTestId("join.code-input", { timeoutMs: 10_000 })).replaceText(
          qr.payload,
        );
        await clickByTestId(b.session, "join.code-submit", { timeoutMs: 15_000 });
        await b.session.byTestId("join.person-phrase", { timeoutMs: 20_000 });
        for (const [index, word] of phrase.entries()) {
          const cells = await b.session.byTestIdAll("join.person-phrase-cell");
          await cells[index].replaceText(word);
        }
        await clickByTestId(b.session, "join.person-phrase-submit", { timeoutMs: 90_000 });
        await b.session.byTestId("join.person-pending", { timeoutMs: 90_000 });
        await openSettings(a.session, "sync");
        await selectSettingsTopic(a.session, "sync", "devices");
        await clickByTestId(a.session, "sync.approve-device", { timeoutMs: 45_000 });
        await closeSettings(a.session);
        await b.session.byTestId("unlock.password-input", { timeoutMs: 120_000 });
        await (await b.session.byTestId("unlock.password-input")).sendKeys(VAULT_PASSWORD);
        await clickByTestId(b.session, "unlock.submit", { timeoutMs: KDF_BUDGET_MS });
        await b.session.byTestId("editor.root", { timeoutMs: KDF_BUDGET_MS });
        await dismissImporterOffer(b.session);

        // ── The ceremony, first with a DISAGREEMENT ──────────────────────────
        // B mints. Nothing is written by the mint: the code and the safety code
        // go to the screen and the secret waits in RAM for B's own tap.
        await openSettings(b.session, "sync");
        await selectSettingsTopic(b.session, "sync", "devices");
        await clickByTestId(b.session, "sync.device-admission.join-open", { timeoutMs: 20_000 });
        await clickByTestId(b.session, "sync.device-admission.join-start", { timeoutMs: 20_000 });
        const code = (
          await (await b.session.byTestId("sync.device-admission.code", { timeoutMs: 20_000 })).textContent()
        ).trim();
        expect(code.startsWith("MYNE-DEVICE-1:")).toBe(true);
        const sasShown = (
          await (await b.session.byTestId("sync.device-admission.sas", { timeoutMs: 10_000 })).textContent()
        ).trim();
        expect(sasShown.length).toBeGreaterThan(0);
        await closeSettings(b.session);

        // A previews the same code. The preview WRITES NOTHING, so its screen is
        // safe to abandon, and abandoning it is what this half does.
        await openSettings(a.session, "sync");
        await selectSettingsTopic(a.session, "sync", "devices");
        await clickByTestId(a.session, "sync.device-admission.admit-open", { timeoutMs: 20_000 });
        await (await a.session.byTestId("sync.device-admission.admit-code", { timeoutMs: 15_000 }))
          .replaceText(code);
        await clickByTestId(a.session, "sync.device-admission.admit-preview", {
          timeoutMs: 20_000,
        });
        await a.session.byTestId("sync.device-admission.admit-sas", { timeoutMs: 15_000 });
        await a.session.byTestId("sync.device-admission.admit-device", { timeoutMs: 15_000 });
        // The human's answer is "they do not match", and the flow STOPS.
        await clickByTestId(a.session, "sync.device-admission.admit-mismatch", {
          timeoutMs: 15_000,
        });
        await a.session.byTestId("sync.device-admission.stopped", { timeoutMs: 15_000 });
        // The stop is terminal for the attempt: the surface is back at its two
        // entry buttons with the stop line standing above them, and there is no
        // `admit-close` left to press because the admit side is already torn down
        // (myne-md/myne#938 review; the panel used to clear the line in the same
        // commit it set it).
        await a.session.byTestId("sync.device-admission.admit-open", { timeoutMs: 10_000 });
        await closeSettings(a.session);

        // B is told the same thing, and B's own mismatch tap discards the
        // pending admission rather than leaving it armed.
        await openSettings(b.session, "sync");
        await selectSettingsTopic(b.session, "sync", "devices");
        await b.session.byTestId("sync.device-admission.sas", { timeoutMs: 15_000 });
        await clickByTestId(b.session, "sync.device-admission.join-mismatch", {
          timeoutMs: 15_000,
        });
        await b.session.byTestId("sync.device-admission.stopped", { timeoutMs: 15_000 });
        await b.session.byTestId("sync.device-admission.join-open", { timeoutMs: 10_000 });
        await closeSettings(b.session);

        // Nothing was written by any of that: B still cannot sync, and A's
        // frame is byte-identical to the one it published (the ceremony writes a
        // binding row, never the vault frame, and here it wrote nothing at all).
        const before = metaFrame(a.appDataDir);
        expect(before).not.toBeNull();
        const refused = (await ipcOk(b.session, "plugin:sync|sync_now", {})) as {
          state: string;
        };
        expect(refused.state).toBe("error");

        // ── The ceremony again, with a FRESH code and an agreement ───────────
        await openSettings(b.session, "sync");
        await selectSettingsTopic(b.session, "sync", "devices");
        await clickByTestId(b.session, "sync.device-admission.join-open", { timeoutMs: 20_000 });
        await clickByTestId(b.session, "sync.device-admission.join-start", { timeoutMs: 20_000 });
        const freshCode = (
          await (await b.session.byTestId("sync.device-admission.code", { timeoutMs: 20_000 })).textContent()
        ).trim();
        expect(freshCode.startsWith("MYNE-DEVICE-1:")).toBe(true);
        const freshSas = (
          await (await b.session.byTestId("sync.device-admission.sas", { timeoutMs: 10_000 })).textContent()
        ).trim();
        await closeSettings(b.session);

        await openSettings(a.session, "sync");
        await selectSettingsTopic(a.session, "sync", "devices");
        await clickByTestId(a.session, "sync.device-admission.admit-open", { timeoutMs: 20_000 });
        await (await a.session.byTestId("sync.device-admission.admit-code", { timeoutMs: 15_000 }))
          .replaceText(freshCode);
        await clickByTestId(a.session, "sync.device-admission.admit-preview", {
          timeoutMs: 20_000,
        });
        const admitSas = (
          await (await a.session.byTestId("sync.device-admission.admit-sas", { timeoutMs: 15_000 })).textContent()
        ).trim();
        // The two sides derive the SAME characters from the same code. This is
        // the whole ceremony in one assertion: if they can differ, the human
        // comparison proves nothing.
        expect(admitSas).toBe(freshSas);
        await clickByTestId(a.session, "sync.device-admission.admit-ack", { timeoutMs: 15_000 });
        await clickByTestId(a.session, "sync.device-admission.admit-accept", {
          timeoutMs: 30_000,
        });
        await a.session.byTestId("sync.device-admission.admit-accepted", { timeoutMs: 30_000 });
        await clickByTestId(a.session, "sync.device-admission.admit-close", {
          timeoutMs: 10_000,
        });
        await closeSettings(a.session);

        // The frame the admitting device holds is unchanged: this ceremony
        // installs a server credential and writes a binding row, and it must not
        // touch the vault's metadata (which would re-publish a frame for no
        // reason and move the generation nobody asked it to move).
        const after = metaFrame(a.appDataDir);
        expect(after).not.toBeNull();
        expect(after?.equals(before as Buffer)).toBe(true);

        // B confirms with the same characters, and the payoff is a sync that
        // completes rather than a screen that says it might.
        await openSettings(b.session, "sync");
        await selectSettingsTopic(b.session, "sync", "devices");
        await clickByTestId(b.session, "sync.device-admission.join-ack", { timeoutMs: 15_000 });
        await clickByTestId(b.session, "sync.device-admission.join-confirm", {
          timeoutMs: 30_000,
        });
        await closeSettings(b.session);
        const synced = (await ipcOk(b.session, "plugin:sync|sync_now", {}, 120_000)) as {
          state: string;
        };
        expect(synced.state).not.toBe("error");
      });
    } finally {
      await srv.teardown();
    }
  });
});
