// MYND-127 — boot-routing bucket scenarios (e2e-state-machine task 1).
//
// `initialStageFromProbe(vaultList, slotMap)` is the routing brain; each
// scenario here pins one vault-count bucket end-to-end through the
// production binary (SYNC-4). Vault-count preconditions are declared
// per scenario (SYNC-6). Slot-priority (reload) buckets live in task 3;
// picker buckets (≥2) in task 2.
//
// SYNC-13: assertion shapes never print fixture credentials.

import { expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { legalConsentSeed } from "./support/multi-device";
import {
  dismissImporterOffer,
  enterRecoveryPhrase,
  openSettings,
  selectPickerRow,
  selectSettingsTopic,
  switchToVault,
  unlockToEditor,
  waitForBannerText,
} from "./support/flows";
import {
  corruptVaultMetaWholesale,
  deleteVaultMetaKeepArtifacts,
  seedLegacyVault,
  seedVault,
  vaultMetaPath,
  type SeededVault,
} from "./support/fixtures";
import type { Session } from "./support/webdriver";
import { UNLOCK_NON_DISTINGUISHING_BANNER } from "../src/lib/load-bearing-copy";

// Story 12 (boot-probe single-fire, the SM-9 prod replacement) is NOT
// asserted here — empirically unobservable on the production bundle
// with zero hooks (SYNC-3/4): WebKitGTK records no resource-timing
// entry for the `ipc://` scheme (verified in-container: 0 entries),
// the binary initializes no tracing subscriber (events go nowhere),
// and a double probe re-renders the same stage without a remount (no
// DOM symptom). Coverage lands as the task-6 Vitest component test
// (mocked probe pair + StrictMode double-mount call count); downgrade
// recorded on MYND-127 with the SM-9/10/11 notes.

describeE2E("boot routing buckets (MYND-127 task 1)", () => {
  it("0 vaults: empty data dir boots to Welcome", async () => {
    // Vault-count precondition: 0.
    await scenario("sm-bucket-0-welcome", {}, async (app) => {
      await app.session.byTestId("welcome.root", { timeoutMs: 20_000 });

      // Clean fixture ⇒ no orphan-residue banner (MYND-159 surface).
      expect(await app.session.byTestIdAll("repair-residue.banner")).toHaveLength(0);
    });
  });

  it("1 vault: boots to Unlock addressed at the lone vault's id, password opens it", async () => {
    // Vault-count precondition: 1 (weak KDF — params live in vault.meta,
    // SYNC-9).
    let fixture!: SeededVault;
    await scenario(
      "sm-bucket-1-unlock",
      {
        seed: (appDataDir) => {
          fixture = seedVault(appDataDir);
        },
      },
      async (app) => {
        // Story 2: vault-addressed targeting, not just the stage name —
        // the Stage payload's `vaultId` is observable on the form
        // (threaded by `initialStageFromProbe`'s single-vault arm).
        const form = await app.session.byTestId("unlock.form", { timeoutMs: 20_000 });
        expect(await form.attribute("data-vault-id")).toBe(fixture.vaultId);

        // End-to-end: the password unwraps exactly this vault's meta
        // through the untouched production unlock path.
        await unlockToEditor(app.session, fixture.password);
      },
    );
  });

  it("corrupted vault: missing vault.meta with artifacts fails closed, no password form", async () => {
    // Vault-count precondition: 1 (discovered, not well-formed).
    let fixture!: SeededVault;
    await scenario(
      "sm-bucket-corrupted",
      {
        seed: (appDataDir) => {
          fixture = seedVault(appDataDir);
          deleteVaultMetaKeepArtifacts(appDataDir, fixture.vaultId);
        },
      },
      async (app) => {
        // Story 3: unlock(Corrupted) → FailClosedError from the first
        // frame; the password form never mounts.
        const failClosed = await app.session.byTestId("fail-closed.root", {
          timeoutMs: 20_000,
        });
        expect(await failClosed.attribute("data-reason")).toBe("corrupted-vault");

        // Single CTA, full-literal copy (fail-closed contract — no
        // welcome/unlock fallback that could overwrite the vault).
        expect(await (await app.session.byTestId("fail-closed.cta")).text()).toBe("Close app");
        expect(await app.session.byTestIdAll("unlock.password-input")).toHaveLength(0);
      },
    );
  });

  // Story 4 (SM-4 rewritten to list-level IoError) — SKIPPED with rationale:
  // the spec'd injection (chmod fault on `vaults/`) does NOT reach the
  // unlock(IoError) arm on the production binary. `discover_vaults`
  // treats an unreadable `vaults/` dir as EMPTY discovery
  // (`core/src/vault_registry.rs:133` — "Discovery never fails on a
  // missing root"), so the boot lands FAIL-OPEN on Welcome; the only
  // remaining Err arm of `vault_list` is `app_data_dir` resolution
  // failure, which is not injectable at-rest. Whether list-level
  // discovery faults should fail open (current) or closed is flagged at
  // the epic level (e2e-testing sync ledger); this scenario lands when
  // that posture decision resolves. The unlock(IoError) RENDER path
  // stays covered by Vitest stage tests.
  it.skip("list-IoError: vaults/ scan fault fails closed with ioKind copy (blocked on fail-open posture decision)", () => {
    // Intentionally empty — see the rationale above.
  });
});

describeE2E("picker boot routing (MYND-127 task 2, ≥2 vaults)", () => {
  // Distinct per-vault passwords so end-to-end targeting is FALSIFIABLE:
  // the wrong-vault password must fail, the right-vault one must open.
  const PASSWORD_A = "e2e-picker-vault-a-pw";
  const PASSWORD_B = "e2e-picker-vault-b-pw";

  it("2 vaults: boots to picker; row select opens Unlock addressed at exactly that vault", async () => {
    // Vault-count precondition: 2 (both well-formed, weak KDF).
    let b!: SeededVault;
    await scenario(
      "sm-picker-targeting",
      {
        seed: (appDataDir) => {
          seedVault(appDataDir, { password: PASSWORD_A });
          b = seedVault(appDataDir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        // Story 5: ≥2 vaults → picker, with one row per vault.
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        const rows = await app.session.byTestIdAll("picker.vault-row");
        expect(rows).toHaveLength(2);

        // Story 6: selecting B opens Unlock targeted at exactly B.
        await selectPickerRow(app.session, b.vaultId);
        const form = await app.session.byTestId("unlock.form");
        expect(await form.attribute("data-vault-id")).toBe(b.vaultId);

        // Targeting proven end-to-end: A's password fails on B…
        const input = await app.session.byTestId("unlock.password-input");
        await input.sendKeys(PASSWORD_A);
        await (await app.session.byTestId("unlock.submit")).click();
        // Full-literal non-distinguishing copy (§7.3, SYNC-8). The helper waits
        // for the rendered TEXT, not only the element: WebKit's `/text` can
        // answer `""` on the first read of a just-inserted banner.
        await waitForBannerText(
          app.session,
          "unlock.error-banner",
          UNLOCK_NON_DISTINGUISHING_BANNER,
        );

        // …and B's password opens B.
        await input.clear();
        await input.sendKeys(PASSWORD_B);
        await (await app.session.byTestId("unlock.submit")).click();
        await app.session.byTestId("editor.root", { timeoutMs: 30_000 });
      },
    );
  });

  it("2 vaults: picker → unlock → back returns to the picker, re-selectable", async () => {
    // Vault-count precondition: 2. The picker → unlock hop was one-way; a
    // mis-picked vault stranded the user on its unlock screen. The back
    // affordance (rendered only on a picker-reached unlock) must return to
    // the picker, and the picker must stay functional afterwards.
    let a!: SeededVault;
    let b!: SeededVault;
    await scenario(
      "sm-picker-back-to-picker",
      {
        seed: (appDataDir) => {
          a = seedVault(appDataDir, { password: PASSWORD_A });
          b = seedVault(appDataDir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });

        // Pick B → unlock addressed at B, with the back affordance present.
        await selectPickerRow(app.session, b.vaultId);
        const formB = await app.session.byTestId("unlock.form");
        expect(await formB.attribute("data-vault-id")).toBe(b.vaultId);
        await (await app.session.byTestId("unlock.back-to-picker")).click();

        // Back lands on the picker again, both rows still present…
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        expect(await app.session.byTestIdAll("picker.vault-row")).toHaveLength(2);

        // …and re-selecting (now A) opens A's unlock, proving it stays usable.
        await selectPickerRow(app.session, a.vaultId);
        const formA = await app.session.byTestId("unlock.form");
        expect(await formA.attribute("data-vault-id")).toBe(a.vaultId);
      },
    );
  });

  it("2 vaults: picker's Create-another enters the creation flow", async () => {
    // Vault-count precondition: 2.
    await scenario(
      "sm-picker-create-another",
      {
        seed: (appDataDir) => {
          seedVault(appDataDir, { password: PASSWORD_A });
          seedVault(appDataDir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await (await app.session.byTestId("picker.create-cta")).click();
        // Creation-flow entry = the flow's FIRST step, which is the vault-name
        // screen since myne-md/myne#468 put `name` ahead of `password`
        // (`reducer.ts` `initialState.step = "name"`, `NUMBERED_STEPS`). Waiting
        // on `create.password-input` here waits for step 2.
        await app.session.byTestId("create.name-input", { timeoutMs: 10_000 });
      },
    );
  });

  it("2 vaults: picker's Add-this-device opens the join modal", async () => {
    // Vault-count precondition: 2. The regression guard for myne#221 — the
    // join modal used to be mounted on the welcome screen alone, which boot
    // routing reaches ONLY at zero vaults. So from the moment this screen can
    // appear at all, joining an existing account had no route: the workaround
    // was deleting every vault on the machine.
    await scenario(
      "sm-picker-join-entry",
      {
        seed: (appDataDir) => {
          seedVault(appDataDir, { password: PASSWORD_A });
          seedVault(appDataDir, { password: PASSWORD_B });
        },
        // The beta-terms gate stands in front of the join form (operations#15),
        // and this scenario is about picker ROUTING — that the Add-this-device
        // CTA reaches the join modal at all — not about the terms. Arriving
        // with consent already given keeps it that way; without it the spec
        // waits out its budget on `join.account-input`, which renders behind
        // the gate, and reports a routing failure that is really a screen the
        // routing correctly reached.
        seedConfig: legalConsentSeed(),
      },
      async (app) => {
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await (await app.session.byTestId("picker.join-cta")).click();
        // Nothing is unlocked on the picker, so the modal opens over it
        // directly — no teardown hop (contrast the switcher entry below).
        await app.session.byTestId("join.modal", { timeoutMs: 10_000 });
        await app.session.byTestId("join.account-input");
        await app.session.byTestId("picker.root");
      },
    );
  });

  it("2 vaults, one corrupted: picker shows both; fail-closed surfaces only after selection", async () => {
    // Vault-count precondition: 2 (one garbage vault.meta — lists as
    // Exists since `is_well_formed` checks presence, not parse; the
    // corruption is discovered by the unlock attempt's parse step).
    let b!: SeededVault;
    await scenario(
      "sm-picker-corrupted-row",
      {
        seed: (appDataDir) => {
          seedVault(appDataDir, { password: PASSWORD_A });
          b = seedVault(appDataDir, { password: PASSWORD_B });
          corruptVaultMetaWholesale(appDataDir, b.vaultId);
        },
      },
      async (app) => {
        // No pre-routing: boot lands on the picker, both rows present.
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        // The shell paints before its rows: `picker.root` resolves on the
        // container, while the rows arrive once `listVaults()` settles, so a
        // one-shot count here reads an empty list on a boot merely slower than
        // the assertion (measured: 1 failure in 3). Wait for the count, which is
        // the shape `e2e/AGENTS.md` asks for (the success condition belongs in
        // the predicate, and a non-null return resolves the wait).
        await app.session.waitUntil(
          async () => {
            const rows = await app.session.byTestIdAll("picker.vault-row");
            return rows.length === 2 ? rows.length : null;
          },
          { label: "the picker lists both vaults", timeoutMs: 15_000 },
        );
        expect(await app.session.byTestIdAll("picker.vault-row")).toHaveLength(2);

        // Selecting the corrupted vault mounts the password form (the
        // picker does not pre-probe health)…
        await selectPickerRow(app.session, b.vaultId);
        const input = await app.session.byTestId("unlock.password-input");

        // …and the submit's `parse_vault_meta` failure routes to the
        // fail-closed corrupted-vault surface (InvalidVaultMeta).
        await input.sendKeys(PASSWORD_B);
        await (await app.session.byTestId("unlock.submit")).click();
        const failClosed = await app.session.byTestId("fail-closed.root", {
          timeoutMs: 15_000,
        });
        expect(await failClosed.attribute("data-reason")).toBe("corrupted-vault");
      },
    );
  });
});

describeE2E("post-delete routing (Settings → Account delete)", () => {
  // Deleting a vault must RE-PROBE the disk and route by the REMAINING
  // vault count, not hardcode Welcome. Pre-fix, `onDeleteVaultSuccess`
  // dispatched a `*.delete-vault-success` Action that always returned
  // `welcome`, so a multi-vault user who deleted one vault landed on the
  // create screen instead of the picker. The fix routes all three delete
  // surfaces through App.tsx's `reprobe()` — the same boot-routing brain
  // that back-from-create and restore-exit already use. Every existing
  // delete scenario is 1 → 0 (where Welcome is coincidentally correct),
  // so this bug lived uncaught; these two scenarios pin the ≥2-remaining
  // and exactly-1-remaining arms. Distinct passwords keep targeting
  // falsifiable (SYNC-6); credentials never reach an assertion (SYNC-13).
  const PASSWORD_A = "e2e-delete-routing-a-pw";
  const PASSWORD_B = "e2e-delete-routing-b-pw";
  const PASSWORD_C = "e2e-delete-routing-c-pw";

  async function deleteOpenVaultFromSettings(session: Session): Promise<void> {
    // Settings → Vault → Danger zone → typed-DELETE gate → Submit.
    await openSettings(session, "vault");
    // The erase CTA is the Vault panel's `danger` topic (myne-md/myne#885);
    // only the active topic's body is mounted.
    await selectSettingsTopic(session, "vault", "danger");
    await (await session.byTestId("settings.delete-vault-cta")).click();
    const confirmInput = await session.byTestId("delete-vault.confirm-input", {
      timeoutMs: 10_000,
    });
    await confirmInput.sendKeys("DELETE");
    const submit = await session.byTestId("delete-vault.submit");
    await session.waitUntil(() => submit.enabled(), {
      label: "delete submit enabled on exact DELETE",
      timeoutMs: 10_000,
    });
    await submit.click();
  }

  it("3 vaults: deleting the open vault from Settings re-routes to the picker with the siblings", async () => {
    // Vault-count precondition: 3 → 2 (the ≥2-remaining picker arm).
    let a!: SeededVault;
    let b!: SeededVault;
    let c!: SeededVault;
    await scenario(
      "sm-delete-to-picker",
      {
        seed: (appDataDir) => {
          a = seedVault(appDataDir, { password: PASSWORD_A });
          b = seedVault(appDataDir, { password: PASSWORD_B });
          c = seedVault(appDataDir, { password: PASSWORD_C });
        },
      },
      async (app) => {
        // Boot → picker (3 rows); open B into the editor.
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        expect(await app.session.byTestIdAll("picker.vault-row")).toHaveLength(3);
        await selectPickerRow(app.session, b.vaultId);
        await unlockToEditor(app.session, PASSWORD_B);
        await dismissImporterOffer(app.session);

        await deleteOpenVaultFromSettings(app.session);

        // Post-fix: reprobe routes to the picker (2 vaults remain), NOT
        // the create/Welcome screen (the regression).
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        expect(await app.session.byTestIdAll("picker.vault-row")).toHaveLength(2);
        expect(await app.session.byTestIdAll("welcome.root")).toHaveLength(0);

        // B's dir is gone; the two siblings survive on disk (SYNC-6 targeting).
        expect(existsSync(join(app.appDataDir, "vaults", b.vaultId))).toBe(false);
        expect(existsSync(join(app.appDataDir, "vaults", a.vaultId))).toBe(true);
        expect(existsSync(join(app.appDataDir, "vaults", c.vaultId))).toBe(true);
      },
    );
  });

  it("2 vaults: deleting the open vault from Settings re-routes to the lone sibling's Unlock", async () => {
    // Vault-count precondition: 2 → 1 (the exactly-one-remaining Unlock arm).
    let a!: SeededVault;
    let b!: SeededVault;
    await scenario(
      "sm-delete-to-unlock",
      {
        seed: (appDataDir) => {
          a = seedVault(appDataDir, { password: PASSWORD_A });
          b = seedVault(appDataDir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await selectPickerRow(app.session, b.vaultId);
        await unlockToEditor(app.session, PASSWORD_B);
        await dismissImporterOffer(app.session);

        await deleteOpenVaultFromSettings(app.session);

        // One vault remains → Unlock addressed at exactly A (no picker,
        // no Welcome), mirroring the single-vault boot bucket.
        const form = await app.session.byTestId("unlock.form", { timeoutMs: 20_000 });
        expect(await form.attribute("data-vault-id")).toBe(a.vaultId);
        expect(await app.session.byTestIdAll("welcome.root")).toHaveLength(0);
        expect(existsSync(join(app.appDataDir, "vaults", b.vaultId))).toBe(false);
        expect(existsSync(join(app.appDataDir, "vaults", a.vaultId))).toBe(true);
      },
    );
  });
});

describeE2E("slot-priority reload routing (MYND-127 task 3)", () => {
  // The Tauri host (and its HashMap<VaultId, Slot>) outlives the JS
  // runtime across a WebView reload — `refresh()` is the production
  // Cmd+R path, zero test hooks (SYNC-3). The ≥2-vault recovery-resume
  // twin lives in MYND-126 (blocked on MYND-220).

  it("Recovering slot: mid-recovery reload boots straight to password-reset, phrase skipped", async () => {
    // Vault-count precondition: 1 (weak KDF; A8d runs in-app).
    let fixture!: SeededVault;
    await scenario(
      "sm-reload-recovering",
      {
        seed: (appDataDir) => {
          fixture = seedVault(appDataDir);
        },
      },
      async (app) => {
        // Drive a real recovery to the post-A8d point: slot=Recovering.
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await (await app.session.byTestId("unlock.recovery-link")).click();
        await enterRecoveryPhrase(app.session, fixture.phrase);
        await (await app.session.byTestId("recover.submit")).click();
        await app.session.byTestId("recover.reset.password-input", { timeoutMs: 30_000 });

        // Story 7: the WebView reloads, the host keeps Slot::Recovering,
        // and the boot probe's slot-priority pins recover(password-reset).
        await app.session.refresh();
        await app.session.byTestId("recover.reset.password-input", { timeoutMs: 20_000 });
        // Phrase entry is skipped — A8d already produced the in-memory
        // root_key in the pre-reload session.
        expect(await app.session.byTestIdAll("recover.phrase-cell")).toHaveLength(0);
      },
    );
  });

  it("Unlocked slot: reload boots straight to the editor, no re-challenge", async () => {
    // Vault-count precondition: 1 (weak KDF).
    let fixture!: SeededVault;
    await scenario(
      "sm-reload-unlocked",
      {
        seed: (appDataDir) => {
          fixture = seedVault(appDataDir);
        },
      },
      async (app) => {
        // Real unlock → editor (slot=Unlocked).
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);

        // Story 8: reload → slot-priority routes straight back to the
        // editor; the unlocked session is not re-challenged.
        await app.session.refresh();
        await app.session.byTestId("editor.root", { timeoutMs: 20_000 });
        expect(await app.session.byTestIdAll("unlock.password-input")).toHaveLength(0);
      },
    );
  });
});

describeE2E("legacy vault/ eager boot migration (MYND-127 task 4)", () => {
  it("legacy layout migrates before routing; original password opens the migrated vault", async () => {
    // Vault-count precondition: legacy single-vault layout (no vaults/).
    let fixture!: SeededVault;
    await scenario(
      "sm-legacy-migration",
      {
        seed: (appDataDir) => {
          fixture = seedLegacyVault(appDataDir);
        },
      },
      async (app) => {
        // Story 9: the setup-hook migration runs BEFORE routing, so the
        // boot lands on Unlock as one ordinary vault — never Welcome,
        // never a legacy-aware special screen.
        const form = await app.session.byTestId("unlock.form", { timeoutMs: 20_000 });

        // Disk contract while still on Unlock: legacy dir gone, exactly
        // one freshly-minted vaults/<id>/ with the 345-byte meta.
        expect(existsSync(join(app.appDataDir, "vault"))).toBe(false);
        const ids = readdirSync(join(app.appDataDir, "vaults"), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
        expect(ids).toHaveLength(1);
        const migratedId = ids[0];
        // Migration mints a FRESH id — the pre-migration one is retired.
        expect(migratedId).not.toBe(fixture.vaultId);
        expect(statSync(vaultMetaPath(app.appDataDir, migratedId)).size).toBe(345);

        // Registry coherent: the cache names exactly the migrated id
        // (shape per `vault_registry.rs::serialize_registry`).
        const registry = JSON.parse(
          readFileSync(join(app.appDataDir, "vaults", "registry.json"), "utf8"),
        ) as { version: number; vaults: Array<{ id: string }> };
        expect(registry.version).toBe(1);
        expect(registry.vaults.map((v) => v.id)).toEqual([migratedId]);

        // Routed as that one vault (vault-addressed unlock target).
        expect(await form.attribute("data-vault-id")).toBe(migratedId);

        // The pre-migration password opens the migrated vault — the
        // bytes moved, the crypto did not.
        await unlockToEditor(app.session, fixture.password);
      },
    );
  });
});

describeE2E("in-app switcher transitions (MYND-127 task 5)", () => {
  const PASSWORD_A = "e2e-switch-vault-a-pw";
  const PASSWORD_B = "e2e-switch-vault-b-pw";

  it("editor → switch-vault locks the current vault and opens the target's unlock", async () => {
    // Vault-count precondition: 2.
    let a!: SeededVault;
    let b!: SeededVault;
    await scenario(
      "sm-switcher-transition",
      {
        seed: (appDataDir) => {
          a = seedVault(appDataDir, { password: PASSWORD_A });
          b = seedVault(appDataDir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        // Boot to picker, open A.
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await selectPickerRow(app.session, a.vaultId);
        await unlockToEditor(app.session, PASSWORD_A);
        await dismissImporterOffer(app.session);

        // Story 10: account-chip switch to B → editor.switch-vault →
        // unlock(Exists, vaultId: B). (The transient switching overlay
        // is too short-lived under a weak-KDF flush to gate on.)
        await switchToVault(app.session, b.vaultId);
        const formB = await app.session.byTestId("unlock.form", { timeoutMs: 15_000 });
        expect(await formB.attribute("data-vault-id")).toBe(b.vaultId);

        // B's unlock completes on B.
        await unlockToEditor(app.session, PASSWORD_B);

        // Sole-Unlocked invariant (SYNC-1): the switch relocked A, so
        // routing back to A re-challenges with the password form rather
        // than reopening a still-unlocked slot.
        await switchToVault(app.session, a.vaultId);
        const formA = await app.session.byTestId("unlock.form", { timeoutMs: 15_000 });
        expect(await formA.attribute("data-vault-id")).toBe(a.vaultId);
        await app.session.byTestId("unlock.password-input");
      },
    );
  });

  it("editor → account-chip Create-another enters the creation flow", async () => {
    // Vault-count precondition: 2 (any unlocked editor).
    let a!: SeededVault;
    await scenario(
      "sm-switcher-create-entry",
      {
        seed: (appDataDir) => {
          a = seedVault(appDataDir, { password: PASSWORD_A });
          seedVault(appDataDir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await selectPickerRow(app.session, a.vaultId);
        await unlockToEditor(app.session, PASSWORD_A);
        await dismissImporterOffer(app.session);

        // editor.create-vault: chip dropdown → "Create another vault".
        await (await app.session.byTestId("switcher.chip")).click();
        await (await app.session.byTestId("switcher.create-cta")).click();
        // Same first step as the picker entry above: the vault-name screen
        // (myne-md/myne#468), not `create.password-input`.
        await app.session.byTestId("create.name-input", { timeoutMs: 10_000 });
      },
    );
  });

  it("editor → account-chip Add-this-device locks the vault, then opens the join modal", async () => {
    // Vault-count precondition: 2 (any unlocked editor). The second half of
    // myne#221, and the teardown is the part worth pinning: `sync_join_account`
    // bootstraps AND unlocks a DIFFERENT vault, and SYNC-1 zeroizes the active
    // one on the way — so the modal must not open over a mounted editor, which
    // would leave it sitting on plaintext whose keys are gone for the whole
    // `join.pending` wait. The entry therefore flushes + `vault_lock()`s and
    // routes to the just-locked vault's unlock screen first.
    let a!: SeededVault;
    await scenario(
      "sm-switcher-join-entry",
      {
        // Same reason as the picker entry above: this scenario is about the
        // switcher's teardown hop — lock, then open the join modal — not about
        // the beta-terms gate that now stands in front of the join form.
        seedConfig: legalConsentSeed(),
        seed: (appDataDir) => {
          a = seedVault(appDataDir, { password: PASSWORD_A });
          seedVault(appDataDir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await selectPickerRow(app.session, a.vaultId);
        await unlockToEditor(app.session, PASSWORD_A);
        await dismissImporterOffer(app.session);

        await (await app.session.byTestId("switcher.chip")).click();
        await (await app.session.byTestId("switcher.join-cta")).click();

        // The editor is gone and A is locked: its unlock form is what the
        // modal sits over, still vault-addressed so cancelling lands the user
        // somewhere they can simply retype the password.
        const form = await app.session.byTestId("unlock.form", { timeoutMs: 15_000 });
        expect(await form.attribute("data-vault-id")).toBe(a.vaultId);
        await app.session.byTestId("unlock.password-input");
        await app.session.byTestId("join.modal", { timeoutMs: 10_000 });
      },
    );
  });
});

describeE2E("SM-12 no stage shortcut (MYND-127 task 6)", () => {
  it("?test-stage=editor has zero routing effect on the production bundle", async () => {
    // Vault-count precondition: 0 (any editor landing would be a leak).
    await scenario("sm-12-no-shortcut", {}, async (app) => {
      await app.session.byTestId("welcome.root", { timeoutMs: 20_000 });

      // Re-enter the app with the would-be dev shortcut present at BOOT
      // (full navigation → fresh JS runtime → boot probe re-runs with
      // the param in place). MYND-80 acceptance: no URL parameter may
      // bypass production routing.
      await app.session.execute(
        "location.href = location.origin + location.pathname + '?test-stage=editor'",
      );
      // Anchor on the POST-navigation document: only it carries the
      // param (the predicate swallows transient mid-navigation errors).
      await app.session.waitUntil(
        async () => {
          try {
            return (
              (await app.session.execute<string>("return location.search")) ===
                "?test-stage=editor" || null
            );
          } catch {
            return null;
          }
        },
        { label: "post-navigation document", timeoutMs: 20_000 },
      );

      // Normal boot routing applies: empty dir → Welcome, never editor.
      await app.session.byTestId("welcome.root", { timeoutMs: 20_000 });
      expect(await app.session.byTestIdAll("editor.root")).toHaveLength(0);
    });
  });
});
