// Account grouping on the locked picker, at the one place a user meets it
// (myne-md/myne#684).
//
//   ag1  cold boot with two vaults: the picker shows standalone rows (no
//        account header), because this device has no keychain to seal the
//        account record with.
//
// ## READ THIS BEFORE CHANGING AN ASSERTION HERE
//
// `core/src/account/key.rs` reuses `vault_label::key::platform_keychain`, which
// has ONE backend, Apple's, and returns `KeychainUnavailable` on every other
// target. This harness is Linux-only (tauri-driver has no macOS support,
// SYNC-1), and the container is the only seat it has in CI or on a developer's
// machine. So in every seat these scenarios can run in, the device has no
// keychain, which means:
//
//   * no account record is ever sealed, because sealing needs a key the device
//     cannot mint. `account_list` therefore answers an empty list and the
//     picker draws every vault as a standalone row with no account header.
//
// The consequence for coverage is stated rather than papered over: **the
// "grouped picker shows the account label" half of #684 is NOT proven here, and
// cannot be**, on this platform. What is proven here is the half that is real on
// a keychain-less device, and it is the half with teeth:
//
//   * nothing is written in the clear as a consolation (the forbidden fallback,
//     `decisions.md` 2026-08-15), asserted by the absence of any `account.json`
//     file and by the picker rendering no account header;
//   * the account_list command answers empty rather than erroring, so the
//     standalone degrade is a value, not a failure.
//
// The grouped path is covered off this lane by the Rust suites, which drive a
// working keychain through the `LabelKeychain` trait
// (`core/src/account/{store,commands}.rs`): upgrade-merges-N-vaults, rename /
// split / move round-trips, hide-vault-names suppression and mutation refusal,
// overlong-label rejection, read-only list (no write-back, undecryptable bytes
// preserved), and eager seal at creation. The grouping helper both pickers
// share is pinned by unit tests on both twins
// (`tests/lib/accountGrouping.test.ts`,
// `mobile/tests/accountGrouping.test.ts`), which fail if the helper ever
// answers `null` unconditionally. What no automated lane drives is the grouped
// RENDERING itself (headers, menus, the sibling notice on a keychain-holding
// device): that half stays a manual roster item until a runner with a keychain
// backend exists.
//
// Vault-count precondition: 2 (weak KDF). SYNC-13: the passwords are in-source
// scenario constants and never reach an assertion diff.

import { expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import { ipcOk } from "./support/flows";
import type { Session } from "./support/webdriver";

const PASSWORD_A = "e2e-account-grouping-a-pw";
const PASSWORD_B = "e2e-account-grouping-b-pw";

const KEYCHAIN_TRIPWIRE =
  "account_list answered a non-empty list in the tauri-driver harness. " +
  "That means a non-Apple keychain backend landed in core/src/vault_label/key.rs, " +
  "and the assertions below stop describing this device. They pin the " +
  "keychain-LESS contract (no account record, no grouping, standalone rows). " +
  "The grouped-picker path of myne-md/myne#684 now needs its own scenario " +
  "here: seed two vaults, drive account_list to a non-empty answer, and assert " +
  "the picker renders an account header over the grouped rows. Do not relax " +
  "this assertion to make the file green.";

/** The account record file path under the app config dir. */
function accountRecordPath(appConfigDir: string): string {
  return join(appConfigDir, "account.json");
}

describeE2E("ag1 the locked picker on a keychain-less device (myne#684)", () => {
  // Vault-count precondition: 2 (weak KDF). The account record is sealed under a
  // keychain key, which the container does not have, so the picker must show
  // standalone rows and no account header.
  it("shows standalone rows and stores no account record in the clear", async () => {
    let a!: SeededVault;
    let b!: SeededVault;
    let dataHome = "";
    let appConfigDir = "";

    try {
      await scenario(
        "ag1-keychain-less-picker",
        {
          keepDataDir: true,
          seed: (dir) => {
            dataHome = dirname(dir);
            a = seedVault(dir, { password: PASSWORD_A });
            b = seedVault(dir, { password: PASSWORD_B });
          },
        },
        async (app) => {
          const s: Session = app.session;
          appConfigDir = app.appConfigDir;

          await s.byTestId("picker.root", { timeoutMs: 20_000 });

          // The account_list command answers empty (a value, not an error), so
          // the picker degrades to standalone rows. This is the tripwire: if a
          // Linux keychain backend ever lands, this answers non-empty and the
          // grouped path becomes owed.
          const accounts = (await ipcOk(s, "plugin:account|account_list")) as unknown[];
          expect(accounts, KEYCHAIN_TRIPWIRE).toEqual([]);

          // No account header renders: every vault is standalone.
          const headers = await s.byTestIdAll("picker.account-header");
          expect(headers).toHaveLength(0);

          // Both rows are present and standalone.
          const rows = await s.byTestIdAll("picker.vault-row");
          expect(rows).toHaveLength(2);
          for (const row of rows) {
            const id = await row.attribute("data-vault-id");
            expect([a.vaultId, b.vaultId]).toContain(id);
          }
        },
      );

      // ---- Post-exit: what is actually on disk ----------------------------
      // No account record file exists: a keychain-less device seals nothing, so
      // the standalone degrade is "there is nothing stored" and not "something
      // is stored and unread".
      expect(existsSync(accountRecordPath(appConfigDir))).toBe(false);
    } finally {
      if (dataHome) rmSync(dataHome, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
