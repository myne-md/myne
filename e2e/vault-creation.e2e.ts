// MYND-124 — vault-creation flow scenarios (e2e-vault-creation).
//
// Creation is the highest-stakes onboarding flow: it mints the only
// credentials that can ever open the vault. VC-1 runs the ONE live
// full-production-KDF creation of the epic and doubles as the
// realistic-fixture capture (SYNC-2). Vault-count preconditions are
// declared per scenario (SYNC-6).
//
// SYNC-13: assertion shapes never print credentials; the scraped
// phrase/password land only in the gitignored fixture artifact.
//
// **Every 0-vault entry is now the first run** (myne-md/myne#911 task 6): the
// welcome screen's one create door opens the identity ceremony, and the vault
// that follows is person-born, so it has NO vault phrase and NO recovery kit.
// The scenarios below that need a vault KIT (copy feedback, the confirm matrix,
// the picker and switcher entries) therefore seed an identity-less vault and
// create a second one, which is the legacy path where the phrase still exists.
// Where a claim moved with the ceremony, the scenario says where it went.

import { expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import {
  clickByTestId,
  startFirstRunIdentity,
  startFirstRunToVault,
} from "./support/flows";
import {
  dismissImporterOffer,
  pageSeatInvoke,
  selectPickerRow,
  switchToVault,
  unlockToEditor,
  waitForBannerText,
} from "./support/flows";
import { seedVault, vaultMetaPath, type SeededVault } from "./support/fixtures";
import { saveRealisticFixture } from "./support/realistic-fixture";
import { scanForPlaintext } from "./support/plaintext-scan";
import { testIdSelector, type Session } from "./support/webdriver";

const VC1_PASSWORD = "Tk9#mQ4!wX7&zR2p-vc1";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The name typed on the flow's first step (myne-md/myne#468). Deliberately
 *  not a plain ASCII word: the value is written as the vault's label through
 *  `prefs|vault_set_label` after the auto-unlock, and it is the header of the
 *  recovery kit and of the file the kit saves. */
const VC_VAULT_NAME = "E2E Kasa";

/** Step over the vault-name step, which is the flow's first screen since
 *  myne-md/myne#468 (pre-KDF, so this spends no Argon2id). */
async function nameVaultStep(session: Session, name = VC_VAULT_NAME): Promise<void> {
  await (await session.byTestId("create.name-input", { timeoutMs: 15_000 })).sendKeys(name);
  await (await session.byTestId("create.name-continue")).click();
  await session.byTestId("create.password-input", { timeoutMs: 10_000 });
}

/** Fill + submit the password step and wait for the recovery kit — i.e.
 *  run ONE production-Argon2id `begin`. The session is live afterwards
 *  (kit step mounted). */
async function submitPasswordStep(session: Session, password: string): Promise<void> {
  await (await session.byTestId("create.password-input")).sendKeys(password);
  await (await session.byTestId("create.confirm-input")).sendKeys(password);
  const submit = await session.byTestId("create.submit");
  await session.waitUntil(() => submit.enabled(), {
    label: "password submit enabled",
    timeoutMs: 15_000,
  });
  await submit.click();
  await session.byTestId("create.phrase-grid", { timeoutMs: 120_000 });
}

/** Scrape the 24 revealed phrase words in data-index order (single
 *  in-page pass — 1 round-trip instead of 48). The word is the LAST
 *  span of each cell (the first is the index numeral). */
async function scrapePhrase(session: Session, stem = "create.phrase-word"): Promise<string[]> {
  const words = await session.execute<string[]>(
    "var words = [];" +
      "for (var i = 1; i <= 24; i++) {" +
      "  var el = document.querySelector(" +
      "    '[data-testid=\"' + arguments[0] + '\"][data-index=\"' + i + '\"] span:last-child');" +
      "  words.push(el ? el.textContent || '' : '');" +
      "}" +
      "return words;",
    [stem],
  );
  // Shape-only check (SYNC-13: never print the words themselves).
  expect(words.length).toBe(24);
  expect(words.every((w) => w.length > 0)).toBe(true);
  return words;
}

/** Fill the 4-of-24 confirm challenge: each input declares its 1-based
 *  position via data-index; type that word from the scraped phrase. */
async function fillConfirmChallenge(session: Session, words: string[]): Promise<void> {
  const cells = await session.byTestIdAll("create.confirm-input");
  // Length-only compare (SYNC-13 shape; 4 cells by §2.3 challenge design).
  expect(cells.length).toBe(4);
  for (const cell of cells) {
    const pos = Number(await cell.attribute("data-index"));
    expect(pos).toBeGreaterThanOrEqual(1);
    expect(pos).toBeLessThanOrEqual(24);
    await cell.sendKeys(words[pos - 1]);
  }
}

describeE2E("VC-1 creation happy path at production KDF (MYND-124 task 1)", () => {
  it("creates an identity, then a vault with no vault phrase, and lands in the editor", async () => {
    // Vault-count precondition: 0. Full production KDF: the identity seed
    // plus creation's own Argon2id pair. SYNC-9: no weak-KDF shortcut exists
    // for creation, by design.
    await scenario("vc1-happy-path", {}, async (app) => {
      // Welcome → the ONE create door → the identity ceremony → briefing.
      await startFirstRunToVault(app.session);

      await (await app.session.byTestId("create.password-input")).sendKeys(VC1_PASSWORD);
      await (await app.session.byTestId("create.confirm-input")).sendKeys(VC1_PASSWORD);
      const submit = await app.session.byTestId("create.submit");
      await app.session.waitUntil(() => submit.enabled(), {
        label: "password submit enabled (zxcvbn ≥3)",
        timeoutMs: 15_000,
      });
      await submit.click();

      // The retirement, asserted as an ABSENCE. A person-born vault has no
      // phrase, so the kit never mounts and `commit` runs straight after
      // `begin`: waiting for Ready is what proves the flow went through
      // `committing` rather than stalling on a screen that no longer exists.
      const done = await app.session.byTestId("create.ready-done", { timeoutMs: 180_000 });
      expect(await app.session.byTestIdAll("create.phrase-grid")).toHaveLength(0);
      expect(await app.session.byTestIdAll("create.kit-sheet")).toHaveLength(0);

      // Ready is forward-only: no Back affordance survives the commit.
      for (const backId of ["create.confirm-back", "create.phrase-back", "create.secondary"]) {
        expect(await app.session.byTestIdAll(backId)).toHaveLength(0);
      }

      // Disk contract BEFORE Done (commit already wrote the layout).
      const vaultsDir = join(app.appDataDir, "vaults");
      const ids = readdirSync(vaultsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      expect(ids).toHaveLength(1);
      const vaultId = ids[0];
      expect(UUID_RE.test(vaultId)).toBe(true);
      const metaPath = join(vaultsDir, vaultId, "vault.meta");
      const metaBytes = readFileSync(metaPath);
      // `NTV7`, not `NTV5`: a vault created under an identity is the
      // person-wrapped generation (myne-md/myne#911 tasks 2 and 5). This
      // assertion IS the birth format's end-to-end proof: it runs against the
      // production binary through the real creation UI, so nothing about it is
      // seeded or mocked.
      expect(metaBytes.subarray(0, 4).toString("latin1")).toBe("NTV7");
      // The frame is `445 + roster_len + 1208`, so it is NOT the 345-byte base.
      // A length check here would be a second opinion about a number task 2
      // owns, so the assertion is the inequality the shape implies.
      expect(metaBytes.length).toBeGreaterThan(345);

      // The two eagerly seeded singletons keep their own generation (`MYP5` /
      // `MYC5`): what changed for this generation is the TIER they are sealed
      // under (group, following the roster), not their inner framing.
      for (const [name, magic] of [
        ["vault.prefs", "MYP5"],
        ["vault.attachments", "MYC5"],
      ] as const) {
        const p = join(vaultsDir, vaultId, name);
        if (existsSync(p)) {
          expect(readFileSync(p).subarray(0, 4).toString("latin1")).toBe(magic);
        } else {
          // eslint-disable-next-line no-console
          console.warn(`[vc1] soft disk-check: ${name} absent (accepted)`);
        }
      }
      // Registry is a LAZY cache (SYNC-10: the disk-scan is the authority).
      const registryPath = join(vaultsDir, "registry.json");
      if (existsSync(registryPath)) {
        const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
          version: number;
          vaults: unknown;
        };
        expect(registry.version).toBe(1);
        expect(Array.isArray(registry.vaults)).toBe(true);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[vc1] soft disk-check: registry.json absent (accepted)");
      }

      // Done → auto-unlock chain (production Argon2id again) → editor.
      await done.click();
      await app.session.byTestId("editor.root", { timeoutMs: 180_000 });

      // The realistic fixture keeps serving the unlock suites, which need a
      // REAL created-by-the-app vault and its password. It no longer carries a
      // phrase, because this vault has none: a suite that needs to RECOVER a
      // vault seeds a legacy one instead (`seedVault({kdf:"production"})`), and
      // that is the path `recovery-drill` and `change-password` now take.
      saveRealisticFixture(
        { vaultId, password: VC1_PASSWORD, phrase: null, account: null },
        metaBytes,
      );

      // Plaintext-never-on-disk: the password is the only credential this
      // scenario holds (SYNC-13: no phrase is ever captured here).
      const hits = scanForPlaintext(app.dataHome, [VC1_PASSWORD]);
      expect(hits).toEqual([]);

      // #393: a freshly-created vault is seeded with a small EXAMPLE VAULT.
      // Unchanged by the generation: creation seeds it on the first unlock
      // chain, and that chain still runs here.
      await dismissImporterOffer(app.session);
      const exampleFolder = await app.session.byTestId("notes.folder-row", {
        timeoutMs: 15_000,
      });
      expect(await exampleFolder.textContent()).toContain("Getting started");
      const indexTab = await app.session.byTestId("editor.tab", { timeoutMs: 15_000 });
      expect(await indexTab.attribute("data-tab-id")).toMatch(/^note:/);
      expect(await indexTab.textContent()).toContain("Start here");
    });
  });
});

describeE2E("VC-2 confirm gating + VC-3 blur cover (MYND-124 task 2)", () => {
  it("the IDENTITY ceremony gates Done per-cell and covers the words on blur", async () => {
    // Vault-count precondition: 0. ONE identity creation (one Argon2id seed
    // derivation) chains both scenarios.
    //
    // **Re-sited, not retired** (myne-md/myne#911 task 6). These two claims used
    // to be asserted on the vault's kit and confirm steps; a person-born vault
    // has neither, because the phrase and its type-back moved to the identity
    // ceremony. The CLAIM is unchanged (a wrong word is refused per cell with
    // its own position; a walk-away hides the words and only Reveal brings them
    // back), and so is the code under test: `PhraseTypeBack` and
    // `useLocalPhraseReveal` are the same shared components, now mounted by the
    // panel. Leaving them asserted nowhere would have been the quiet loss.
    await scenario("vc2-vc3-confirm-and-cover", {}, async (app) => {
      const s = app.session;
      await (await s.byTestId("welcome.create-cta", { timeoutMs: 20_000 })).click();
      await s.byTestId("first-run.root", { timeoutMs: 15_000 });
      await (await s.byTestId("first-run.identity.create-cta", { timeoutMs: 20_000 })).click();
      await s.byTestId("first-run.identity.phrase", { timeoutMs: 120_000 });
      await (await s.byTestId("first-run.identity.phrase-reveal")).click();
      const words = await scrapePhrase(s, "first-run.identity.phrase-word");
      await (await s.byTestId("first-run.identity.phrase-continue")).click();

      // ── VC-2: per-cell mismatch gating on the type-back ──
      await s.byTestId("first-run.identity.confirm-input", { timeoutMs: 10_000 });
      const cells = await s.byTestIdAll("first-run.identity.confirm-input");
      expect(cells.length).toBe(4);
      const firstPos = Number(await cells[0].attribute("data-index"));

      // Wrong word (not in any BIP-39 list) → the per-cell error with its
      // position-addressed copy, and Done stays refused.
      await cells[0].sendKeys("zzzzzz");
      const cellError = await s.waitForElement(
        testIdSelector("first-run.identity.confirm-error", {
          "data-index": String(firstPos),
        }),
      );
      expect(await cellError.text()).toBe(`That does not match word #${firstPos}.`);
      const done = await s.byTestId("first-run.identity.close-cta");
      expect(await done.enabled()).toBe(false);

      // No autocomplete/typeahead surface: the type-back must PROVE recall.
      for (const cell of cells) {
        expect(await cell.attribute("autocomplete")).toBe("off");
        expect(await cell.attribute("spellcheck")).toBe("false");
        expect(await cell.attribute("list")).toBeNull();
      }
      expect(await s.findElements("[role='listbox'], datalist")).toHaveLength(0);

      // Correct the cell with UPPERCASE input: `normalizeWord` (NFKD +
      // case-fold) accepts it and the error clears.
      await cells[0].replaceText(words[firstPos - 1].toUpperCase());
      await s.waitForGone(
        testIdSelector("first-run.identity.confirm-error", {
          "data-index": String(firstPos),
        }),
      );

      for (const cell of cells.slice(1)) {
        const pos = Number(await cell.attribute("data-index"));
        await cell.sendKeys(words[pos - 1]);
      }
      await s.waitUntil(() => done.enabled(), {
        label: "identity Done enabled (4/4 match)",
        timeoutMs: 10_000,
      });

      // ── VC-3: blur cover on the phrase step (walk-away guard) ──
      // Back remounts the phrase step; re-fetch the grid handle, because the
      // pre-confirm element is a stale reference.
      await (await s.byTestId("first-run.identity.confirm-back")).click();
      const gridBack = await s.byTestId("first-run.identity.phrase", { timeoutMs: 10_000 });
      await s.waitUntil(
        async () => (await gridBack.attribute("data-revealed")) === "true" || null,
        { label: "phrase still revealed after Back", timeoutMs: 10_000 },
      );

      // The production listener is `window.addEventListener("blur")`; fire the
      // same event the OS does on Cmd-Tab.
      await s.execute("window.dispatchEvent(new Event('blur'))");
      await s.waitUntil(
        async () => (await gridBack.attribute("data-revealed")) === "false" || null,
        { label: "cover dropped on blur", timeoutMs: 10_000 },
      );

      // Refocus does NOT restore (protocol.md §2.2: re-reveal is explicit).
      await s.execute("window.dispatchEvent(new Event('focus'))");
      expect(await gridBack.attribute("data-revealed")).toBe("false");

      await (await s.byTestId("first-run.identity.phrase-reveal")).click();
      await s.waitUntil(
        async () => (await gridBack.attribute("data-revealed")) === "true" || null,
        { label: "re-revealed via button", timeoutMs: 10_000 },
      );
    });
  });
});

describeE2E("VC-4 back-navigation matrix (MYND-124 task 3, post-MYND-219)", () => {
  it("Back from the password step keeps the name; Back again lands on the identity home", async () => {
    // Vault-count precondition: 0. Whole scenario walks only up to the password
    // form, so it spends the identity's Argon2id and nothing more.
    //
    // **What left this scenario** (myne-md/myne#911 task 6): the Confirm↔Kit
    // state matrix and "Back-from-Phrase is a clean restart". Both were
    // assertions about the VAULT phrase step, which a person-born vault does not
    // have. Their equivalents now live on the identity ceremony, in VC-2/VC-3
    // above (the challenge's own round trip and reveal behaviour) and in
    // `e2e/first-run-offline.e2e.ts` (the ceremony end to end). What remains
    // here is the part that was never about the phrase.
    await scenario("vc4-clean-restart", {}, async (app) => {
      const s = app.session;
      await startFirstRunToVault(s);

      // Arm 6, first hop: Back from the password step is ONE step, to the name
      // step, with the typed name kept (myne-md/myne#468).
      await (await s.byTestId("create.secondary")).click();
      const backAtName = await s.byTestId("create.name-input", { timeoutMs: 15_000 });
      expect(
        await backAtName.property<string>("value"),
        "the back-step must keep the name the user already typed",
      ).toBe("E2E Kasa");

      // Arm 6, second hop: Back again leaves creation. Boot routing decides
      // where, and it is NOT Welcome any more: an identity now exists on this
      // device, so the zero-vault arm lands on the identity home (myne-md/myne#911
      // task 4). That is also the honest answer to "the user abandoned the first
      // run", the identity they just created is real and stays.
      await (await s.byTestId("create.name-back")).click();
      await s.byTestId("identity-home.root", { timeoutMs: 20_000 });
    });
  });

  it("create entered from the picker returns to the picker on Back (MYND-219 reprobe)", async () => {
    // Vault-count precondition: 2 (weak KDF; Back fires BEFORE begin —
    // no Argon2id spend). Unchanged by the first-run rework: a device with
    // vaults has no identity, so "create another" is the LEGACY path, phrase
    // and all.
    await scenario(
      "vc4-back-to-picker",
      {
        seed: (appDataDir) => {
          seedVault(appDataDir, { password: "e2e-vc4-vault-a-pw" });
          seedVault(appDataDir, { password: "e2e-vc4-vault-b-pw" });
        },
      },
      async (app) => {
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await (await app.session.byTestId("picker.create-cta")).click();
        await nameVaultStep(app.session);

        // First-run-only scoping (MYND-114): the picker "create another"
        // entry shows NO safety briefing.
        expect(await app.session.byTestIdAll("create.briefing")).toHaveLength(0);

        await (await app.session.byTestId("create.secondary")).click();
        await app.session.byTestId("create.name-input", { timeoutMs: 15_000 });
        await (await app.session.byTestId("create.name-back")).click();
        await app.session.byTestId("picker.root", { timeoutMs: 15_000 });
      },
    );
  });
});

/** Drive the PASSWORD step of a person-born creation → ReadyStep through the
 *  real UI (one production begin). No kit and no type-back: this generation has
 *  no vault phrase, so `begin` auto-commits and Ready is the first screen after
 *  the password. Caller decides what to do at Ready. */
async function createPersonVaultToReady(session: Session, password: string): Promise<void> {
  await (await session.byTestId("create.password-input")).sendKeys(password);
  await (await session.byTestId("create.confirm-input")).sendKeys(password);
  const submit = await session.byTestId("create.submit");
  await session.waitUntil(() => submit.enabled(), {
    label: "password submit enabled",
    timeoutMs: 15_000,
  });
  await submit.click();
  await session.byTestId("create.ready-done", { timeoutMs: 180_000 });
}

/** Drive password → recovery kit → confirm (which commits) → ReadyStep through
 *  the real UI (one production begin). Caller decides what to do at Ready.
 *
 *  The KIT path, still used by the picker and switcher entries: those devices
 *  hold seeded vaults and no identity, so "create another" is the legacy birth
 *  with its phrase. A personality-created vault must use
 *  [`createPersonVaultToReady`] instead. */
async function createToReadyStep(session: Session, password: string): Promise<void> {
  await submitPasswordStep(session, password);
  await (await session.byTestId("create.phrase-reveal")).click();
  const words = await scrapePhrase(session);
  await (await session.byTestId("create.phrase-continue")).click();
  await session.byTestId("create.confirm-input", { timeoutMs: 10_000 });
  await fillConfirmChallenge(session, words);
  const confirmContinue = await session.byTestId("create.confirm-continue");
  await session.waitUntil(() => confirmContinue.enabled(), {
    label: "confirm continue enabled",
    timeoutMs: 10_000,
  });
  await confirmContinue.click();
  await session.byTestId("create.ready-done", { timeoutMs: 60_000 });
}

describeE2E("VC-5 VaultArtifactsPresent guard + same-token retry (MYND-124 task 4)", () => {
  it("override-commit at an existing vault fails closed; the restored session then commits normally", async () => {
    // Vault-count precondition: 2 (entry surface = picker; vault A is
    // the guard's collision target).
    let a!: SeededVault;
    await scenario(
      "vc5-artifacts-guard",
      {
        seed: (appDataDir) => {
          a = seedVault(appDataDir, { password: "e2e-vc5-vault-a-pw" });
          seedVault(appDataDir, { password: "e2e-vc5-vault-b-pw" });
        },
      },
      async (app) => {
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });

        // Run a REAL `begin` from the page seat (the production IPC
        // entry point — `__TAURI_INTERNALS__.invoke` is what the
        // bundled API calls; zero production change, SYNC-3 is a
        // production-code policy). The UI stays on the picker — the
        // backend session is what the guard contract is about.
        // Production Argon2id pair — budget generously.
        const begun = await pageSeatInvoke(
          app.session,
          "plugin:vault-creation|begin",
          { password: "e2e-vc5-new-vault-pw" },
          120_000,
        );
        expect(begun.err).toBeUndefined();
        const token = (begun.ok as { session_token: string }).session_token;

        // Guard trigger: the documented `vault_id` override escape
        // hatch pointed at EXISTING vault A.
        const metaBefore = readFileSync(vaultMetaPath(app.appDataDir, a.vaultId));
        const guarded = await pageSeatInvoke(
          app.session,
          "plugin:vault-creation|commit",
          { vaultId: a.vaultId, sessionToken: token },
          30_000,
        );
        expect(guarded.err).toEqual({ kind: "VaultArtifactsPresent" });

        // Non-destructive: A's bytes are byte-identical.
        expect(readFileSync(vaultMetaPath(app.appDataDir, a.vaultId)).equals(metaBefore)).toBe(
          true,
        );

        // Same-token retry WITHOUT the override: the restored session
        // commits to its own freshly-minted vaults/<id2>/.
        const retried = await pageSeatInvoke(
          app.session,
          "plugin:vault-creation|commit",
          { sessionToken: token },
          30_000,
        );
        expect(retried.err).toBeUndefined();
        const newId = retried.ok as string;
        expect(typeof newId).toBe("string");
        expect(newId).not.toBe(a.vaultId);
        expect(statSync(vaultMetaPath(app.appDataDir, newId)).size).toBe(345);
      },
    );
  });
});

describeE2E("VC-6 auto-unlock-failure fallback (MYND-124 task 5)", () => {
  it("Done with a vanished vault.meta lands on unlock targeting the just-created vault", async () => {
    // Vault-count precondition: 0 → 1 (the created vault).
    await scenario("vc6-auto-unlock-fallback", {}, async (app) => {
      await startFirstRunToVault(app.session);
      await createPersonVaultToReady(app.session, VC1_PASSWORD);

      // At-rest fault injection BEFORE Done: delete the just-committed
      // vault.meta so the chained auto-unlock rejects naturally.
      const ids = readdirSync(join(app.appDataDir, "vaults"), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      expect(ids).toHaveLength(1);
      const createdId = ids[0];
      rmSync(vaultMetaPath(app.appDataDir, createdId));

      // Done → vault_unlock rejects → create-vault.commit-success
      // fallback → unlock(Exists) TARGETING the created vault (not the
      // sole-vault fallback).
      await (await app.session.byTestId("create.ready-done")).click();
      const form = await app.session.byTestId("unlock.form", { timeoutMs: 60_000 });
      expect(await form.attribute("data-vault-id")).toBe(createdId);

      // The targeted manual retry proves the address end-to-end: the
      // vault.meta is gone, so the unlock surfaces the VaultNotFound
      // banner (full literal) rather than a wrong-vault attempt.
      await (await app.session.byTestId("unlock.password-input")).sendKeys(VC1_PASSWORD);
      await (await app.session.byTestId("unlock.submit")).click();
      // Full-literal equality, POLLED (`waitForBannerText`): a one-shot
      // `GET /text` on a banner the render tree has just received can answer
      // `""` while the DOM already holds the copy (that helper's header records
      // the measurement), and the failure then reads as a wrong banner.
      await waitForBannerText(
        app.session,
        "unlock.error-banner",
        "Vault file not found. Please restart the app.",
      );
    });
  });
});

describeE2E("VC-9/VC-10 create-second-vault entries (MYND-124 task 6)", () => {
  const PASSWORD_A = "e2e-vc9-vault-a-pw";
  const PASSWORD_B = "e2e-vc9-vault-b-pw";
  const PASSWORD_NEW = "Tk9#mQ4!wX7&zR2p-vc9";

  it("picker entry: Create-another mints a fresh vault, no guard trip, prior vaults untouched", async () => {
    // Vault-count precondition: 2 → 3.
    let a!: SeededVault;
    await scenario(
      "vc9-picker-entry",
      {
        seed: (appDataDir) => {
          a = seedVault(appDataDir, { password: PASSWORD_A });
          seedVault(appDataDir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        const metaBefore = readFileSync(vaultMetaPath(app.appDataDir, a.vaultId));
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await (await app.session.byTestId("picker.create-cta")).click();
        // Name step first: only the briefing is first-run-only (myne-md/myne#468).
        await nameVaultStep(app.session);
        await createToReadyStep(app.session, PASSWORD_NEW);
        await (await app.session.byTestId("create.ready-done")).click();
        await app.session.byTestId("editor.root", { timeoutMs: 120_000 });

        // Fresh vaults/<id3>/ minted; no VaultArtifactsPresent trip
        // (we reached the editor); prior vault bytes untouched.
        const ids = readdirSync(join(app.appDataDir, "vaults"), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
        expect(ids).toHaveLength(3);
        expect(readFileSync(vaultMetaPath(app.appDataDir, a.vaultId)).equals(metaBefore)).toBe(
          true,
        );
      },
    );
  });

  it("editor entry: Create-another locks the prior vault (sole-Unlocked) and lands in the new one", async () => {
    // Vault-count precondition: 2 → 3 (A unlocked at entry).
    let a!: SeededVault;
    await scenario(
      "vc10-editor-entry",
      {
        seed: (appDataDir) => {
          a = seedVault(appDataDir, { password: PASSWORD_A });
          seedVault(appDataDir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        // Unlock A from the picker.
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await selectPickerRow(app.session, a.vaultId);
        await unlockToEditor(app.session, PASSWORD_A);
        await dismissImporterOffer(app.session);

        // Account-chip → "Create another vault" → full create → editor
        // of the NEW vault (auto-unlock evicts A per SYNC-1).
        await (await app.session.byTestId("switcher.chip")).click();
        await (await app.session.byTestId("switcher.create-cta")).click();
        // Same name step as the picker entry (myne-md/myne#468).
        await nameVaultStep(app.session);
        await createToReadyStep(app.session, PASSWORD_NEW);
        await (await app.session.byTestId("create.ready-done")).click();
        await app.session.byTestId("editor.root", { timeoutMs: 120_000 });

        // Sole-Unlocked invariant: routing back to A re-challenges with
        // the password form (A was locked during the flow).
        await switchToVault(app.session, a.vaultId);
        const formA = await app.session.byTestId("unlock.form", { timeoutMs: 15_000 });
        expect(await formA.attribute("data-vault-id")).toBe(a.vaultId);
        await app.session.byTestId("unlock.password-input");
      },
    );
  });
});

describeE2E("MYND-114 first-run safety briefing (pre-vault-create contract)", () => {
  it("gates Continue on three acknowledgements, expands Why? inline, and Back leaves the flow", async () => {
    // Vault-count precondition: 0. The briefing itself is pre-KDF, but the
    // FIRST RUN now reaches it through the identity ceremony, which is not:
    // one identity creation pays one Argon2id seed derivation.
    await scenario("mynd114-safety-briefing", {}, async (app) => {
      // Welcome → the one create door → identity ceremony → the briefing gates
      // vault creation, no password yet (myne-md/myne#911 task 6).
      await startFirstRunIdentity(app.session);
      await app.session.byTestId("create.briefing", { timeoutMs: 15_000 });
      expect(await app.session.byTestIdAll("create.password-input")).toHaveLength(0);

      // Back leaves the flow, and the surface it returns to is the identity
      // home: the identity now exists on this device, so boot routing answers
      // with the screen that owns it rather than Welcome (myne-md/myne#911
      // task 4). The contract is declinable, not a trap, and the identity is
      // not undone by declining.
      await (await app.session.byTestId("create.briefing-back")).click();
      await app.session.byTestId("identity-home.root", { timeoutMs: 20_000 });

      // Re-enter from the identity home: a fresh mount re-arms the gate
      // (acknowledgements reset). `clickByTestId`, not a bare element click:
      // the identity home's action sits inside `CenteredCard`'s own scroller,
      // and WebKit refused a plain `/click` with "element not interactable"
      // for 10 s while the DOM dump showed the button present and unobscured.
      await clickByTestId(app.session, "identity-home.create-vault-cta");
      await app.session.byTestId("create.briefing", { timeoutMs: 15_000 });
      const cont = await app.session.byTestId("create.briefing-continue");
      expect(await cont.enabled()).toBe(false);

      // "Why?" is opt-in: collapsed by default, expands inline, re-collapses.
      const why = (await app.session.byTestIdAll("create.briefing-why"))[1];
      const ackId = await why.attribute("data-ack-id");
      const whyText = testIdSelector("create.briefing-why-text", {
        "data-ack-id": ackId!,
      });
      expect(await why.attribute("aria-expanded")).toBe("false");
      expect(await app.session.findElements(whyText)).toHaveLength(0);
      await why.click();
      await app.session.waitForElement(whyText);
      expect(await why.attribute("aria-expanded")).toBe("true");
      await why.click();
      await app.session.waitForGone(whyText);

      // The gate opens only after ALL three are acknowledged — not before.
      const acks = await app.session.byTestIdAll("create.briefing-ack");
      expect(acks.length).toBe(3);
      await acks[0].click();
      expect(await cont.enabled()).toBe(false);
      await acks[1].click();
      expect(await cont.enabled()).toBe(false);
      await acks[2].click();
      await app.session.waitUntil(() => cont.enabled(), {
        label: "briefing continue enabled (3/3 acknowledged)",
        timeoutMs: 10_000,
      });

      // Continue → the NAME step, then the password step. Before myne-md/myne#468
      // the briefing was forward-only straight into the password; a name step
      // now sits between them, so the claim "Continue moves the flow on" is
      // asserted through the step that is actually next.
      await cont.click();
      await app.session.byTestId("create.name-input", { timeoutMs: 15_000 });
      await nameVaultStep(app.session);
    });
  });
});
