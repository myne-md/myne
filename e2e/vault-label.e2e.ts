// Sealed vault-label store, at the two places a user meets it (myne-md/myne#411).
//
//   vl1  cold boot after a prior unlock: what the LOCKED picker draws, and what
//        is on disk behind it.
//   vl2  turning "Hide vault names on the lock screen" on: the sweep, proven by
//        reading the filesystem afterwards rather than by the command's Ok.
//
// ## READ THIS BEFORE CHANGING AN ASSERTION HERE
//
// `core/src/vault_label/key.rs::platform_keychain` has ONE backend, Apple's, and
// returns `KeychainUnavailable` on every other target. This harness is
// Linux-only (tauri-driver has no macOS support, SYNC-1), and the container is
// the only seat it has in CI or on a developer's machine. So in every seat these
// scenarios can run in, the device has no keychain, which means:
//
//   * no vault name is ever sealed, because sealing needs a key the device
//     cannot mint. `vault_list` therefore resolves every label to `null` and the
//     picker draws the neutral "Vault N" fallback for every row, always.
//   * the hide-vault-names option cannot be turned ON, because the erase it
//     performs starts by destroying keys that do not exist to destroy. The
//     command refuses and, deliberately, persists no flag.
//
// The consequence for coverage is stated rather than papered over: **the
// "a cold boot shows the real name" half of #411 is NOT proven here, and cannot
// be**, on this platform. What is proven here is the half that is real on a
// keychain-less device, and it is the half with teeth:
//
//   * nothing is written in the clear as a consolation (the forbidden fallback,
//     `decisions.md` 2026-08-15), asserted by scanning the vault tree for the
//     name and by the absence of any `vault.label` file;
//   * the "Vault N" number is the VAULT's, not the row's, across two processes
//     with a different unlock order in between;
//   * the sweep really removes files, on every vault it discovers on disk and
//     not only on the one that happens to be open;
//   * a refused enable records NO flag, so nothing on screen can read "hidden"
//     over keys that were never touched.
//
// Both scenarios open by asserting `vault_label_keychain_status` answers
// `available: false`. That is not decoration: it is a TRIPWIRE. If a Linux
// secret-service backend ever lands, these scenarios go red naming exactly the
// coverage that then becomes owed (the real-name path), instead of quietly
// continuing to assert a degraded state nobody meant to keep testing.
//
// The real-name path is covered off this lane by the Rust suites, which drive a
// working keychain through the `LabelKeychain` trait
// (`core/src/vault_label/{store,writeback,erase_all}.rs`, and the `vault_list`
// resolver tests in `core/src/plugins/vault_unlock/commands.rs`).
//
// Vault-count precondition: 2 in both scenarios (weak KDF, so unlock reads its
// params from `vault.meta`). SYNC-13: the passwords are in-source scenario
// constants and never reach an assertion diff; the vault NAME is not a
// credential (it is the user's own text, the same class as note content) and is
// used as a residue needle, so it follows the needle-design rule in
// `support/plaintext-scan.ts`: one lowercase alphanumeric token of 24+ chars.

import { expect, it } from "vitest";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import {
  hideVaultNamesFlagPath,
  seedVault,
  vaultLabelPath,
  type SeededVault,
} from "./support/fixtures";
import {
  closeSettings,
  dismissImporterOffer,
  ipcOk,
  openSettings,
  selectPickerRow,
  unlockToEditor,
} from "./support/flows";
import { scanForPlaintext, waitForFsQuiescence } from "./support/plaintext-scan";
import { testIdSelector, type Session } from "./support/webdriver";

const PASSWORD_A = "e2e-vault-label-a-pw";
const PASSWORD_B = "e2e-vault-label-b-pw";

// The vault name under test. Not a credential; it is a residue needle, so it
// obeys the plaintext-scan needle rule (a single lowercase alphanumeric token of
// 24+ chars survives the search tokenizer verbatim).
// secret-scan:allow - a vault NAME chosen to be scannable, not a secret
const VAULT_NAME = "cobaltnotebook7k2m9qx4w8e5rj";

const KEYCHAIN_TRIPWIRE =
  "vault_label_keychain_status answered available:true in the tauri-driver harness. " +
  "That means a non-Apple keychain backend landed in core/src/vault_label/key.rs, " +
  "and the assertions below stop describing this device. They pin the " +
  "keychain-LESS contract (nothing sealed, nothing shown, the option refuses to " +
  "enable). The real-name path of myne-md/myne#411 now needs its own scenario " +
  "here: unlock a vault, name it, restart, and assert the picker row carries the " +
  "name. Do not relax this assertion to make the file green.";

/**
 * Assert this device has no usable keychain, through the production probe.
 *
 * Reachable pre-unlock by design (the picker is the surface the option governs
 * and it runs before any vault is open), so this doubles as the ACL check for
 * `vault-label:allow-vault-label-keychain-status` on a locked screen.
 */
async function assertNoKeychainOnThisDevice(s: Session): Promise<void> {
  const view = (await ipcOk(s, "plugin:vault-label|vault_label_keychain_status")) as {
    available: boolean;
  };
  expect(view.available, KEYCHAIN_TRIPWIRE).toBe(false);
}

/** One picker row's full rendered text, addressed by vault id. `textContent`
 *  rather than `text()`: the row nests its label and its relative-time meta in
 *  sibling spans, and this driver's W3C getText drops nested text. */
async function pickerRowText(s: Session, vaultId: string): Promise<string> {
  const row = await s.waitForElement(
    testIdSelector("picker.vault-row", { "data-vault-id": vaultId }),
  );
  return (await row.textContent()).trim();
}

/**
 * Name the open vault through Settings, the real rename surface.
 *
 * Two waits carry the weight. The panel loads the current label from
 * `vault.prefs` asynchronously on mount and writes it into the draft when it
 * lands, so a value typed before that read is silently overwritten: the loop
 * re-types until the field holds what was asked for. And the pending-rename
 * notice (the whole mitigation for the cross-device staleness window, #411 task
 * 4) renders exactly while the draft differs from what is saved, so watching it
 * appear and then go is a real write-landed signal rather than a paint wait.
 */
async function nameTheOpenVault(s: Session, name: string): Promise<void> {
  await openSettings(s, "vault"); // The vault label lives in the Vault panel.
  const field = await s.byTestId("settings.label-input");
  await field.scrollIntoView();
  await field.replaceText(name);

  // The mount read lands ONCE. Requiring the value to hold across several polls
  // (100 ms apart) closes the window in which it lands between a successful
  // single check and the click below, which would leave the draft empty, the
  // Save button disabled, and the notice gone for the wrong reason.
  let stable = 0;
  await s.waitUntil(
    async () => {
      const el = await s.byTestId("settings.label-input");
      if ((await el.property<string>("value")) === name) {
        stable += 1;
        return stable >= 5 ? true : null;
      }
      stable = 0;
      await el.replaceText(name);
      return null;
    },
    { label: "vault-name draft settled", timeoutMs: 20_000 },
  );

  // Present while the rename is pending: the sentence that tells the user the
  // old name stays on this account's other devices until the vault is unlocked
  // there. Its absence is a shipped-without-the-mitigation regression.
  await s.byTestId("settings.label-rename-notice");
  await (await s.byTestId("settings.label-save")).click();
  // The notice unmounts when `savedLabel` catches up with the draft, which is
  // the write landing. Re-reading the field afterwards is what separates that
  // from the other way the notice can vanish (the draft being reset to what was
  // already saved).
  await s.waitForGone(testIdSelector("settings.label-rename-notice"));
  expect(await (await s.byTestId("settings.label-input")).property<string>("value")).toBe(name);
  await closeSettings(s);
}

/**
 * A `vault.label` file at rest, for a name this platform cannot produce.
 *
 * Sealing a real one needs a keychain key, which is exactly what the container
 * has not got, so the sweep is driven against a file of the right name carrying
 * the right magic and nothing else. That is sound for what vl2 asserts: the
 * erase never READS this file, it destroys a key and unlinks a path
 * (`core/src/vault_label/store.rs::erase`). It is also stable only BECAUSE the
 * device has no keychain: on a machine with one, the first `vault_list` would
 * classify it `Unreadable` and delete it as an orphan, which is the tripwire
 * above firing rather than a surprise.
 */
function sealedLabelPlaceholder(): Buffer {
  // `MYL1` + protocol version 0x01, then filler standing in for the header's
  // vault id + nonce + length and the ciphertext (protocol.md § 9.22.1).
  return Buffer.concat([
    Buffer.from("MYL1", "latin1"),
    Buffer.from([0x01]),
    Buffer.alloc(96, 0x5a),
  ]);
}

describeE2E("vl1 the locked picker on a cold boot after a prior unlock (myne#411)", () => {
  // Vault-count precondition: 2 (weak KDF). Two launches share one vault tree,
  // because a genuine cold boot is a second PROCESS: launch 1 unlocks a vault
  // and names it, launch 2 boots from a copy of what that left on disk.
  it("shows a stable Vault N and has stored the name nowhere in the clear", async () => {
    let a!: SeededVault;
    let b!: SeededVault;
    let warmDataHome = "";
    let warmAppDataDir = "";
    let coldDataHome = "";
    let coldAppDataDir = "";

    try {
      // ---- Launch 1: unlock the vault that sorts SECOND, and name it --------
      await scenario(
        "vl1-warm-name-a-vault",
        {
          // Kept so launch 2 can copy the tree, and so the post-exit scans below
          // see what launch 1 actually left behind.
          keepDataDir: true,
          seed: (dir) => {
            warmDataHome = dirname(dir);
            a = seedVault(dir, { password: PASSWORD_A });
            b = seedVault(dir, { password: PASSWORD_B });
          },
        },
        async (app) => {
          const s = app.session;
          warmAppDataDir = app.appDataDir;

          await s.byTestId("picker.root", { timeoutMs: 20_000 });
          await assertNoKeychainOnThisDevice(s);

          // "Vault N" is the vault's 1-based rank in ascending VaultId order.
          // Nothing has been unlocked yet, so the list is in id order too and
          // position happens to EQUAL rank here. That coincidence is why launch
          // 2 is the falsifying half: under the old positional fallback these
          // two runs would disagree.
          const [first, second] = a.vaultId < b.vaultId ? [a, b] : [b, a];
          expect(await pickerRowText(s, first.vaultId)).toMatch(/^Vault 1/);
          expect(await pickerRowText(s, second.vaultId)).toMatch(/^Vault 2/);

          // Unlocking the SECOND-sorting vault is what makes launch 2's
          // last-unlock ordering disagree with the rank ordering. Unlocking the
          // first-sorting one would leave the two orders identical and the
          // scenario would pass on the bug it exists to catch.
          await selectPickerRow(s, second.vaultId);
          await unlockToEditor(s, second === a ? PASSWORD_A : PASSWORD_B);
          await dismissImporterOffer(s);
          await nameTheOpenVault(s, VAULT_NAME);

          // Positive control for every "the name is not on disk in the clear"
          // assertion below: the name really WAS saved, sealed, into vault.prefs.
          // Without it the scans could pass on a rename that silently never
          // happened.
          //
          // The magic is asserted against a SET rather than one value, the same
          // way PS-1 handles note blobs: a vault seeded today is born v0.2
          // (`decisions.md` 2026-08-13), whose prefs family is `MYP5`
          // (`protocol.md` § 10.3), while a pre-flip vault's is `MYP1`. Either
          // satisfies this control. What it must never accept is a prefs file
          // that is neither, which is what a plaintext one would be.
          const prefs = readFileSync(
            join(warmAppDataDir, "vaults", second.vaultId, "vault.prefs"),
          );
          expect(["MYP1", "MYP5"]).toContain(prefs.subarray(0, 4).toString("latin1"));
          expect(prefs.length).toBeGreaterThan(VAULT_NAME.length);
        },
      );

      const [first, second] = a.vaultId < b.vaultId ? [a, b] : [b, a];

      // ---- Launch 2: the cold boot -----------------------------------------
      await scenario(
        "vl1-cold-boot",
        {
          keepDataDir: true,
          seed: (dir) => {
            coldDataHome = dirname(dir);
            // Launch 2's own appDataDir is empty; lay launch 1's tree into it.
            // Every path is resolved from app_data_dir at runtime, so moving the
            // tree to a new absolute home is transparent (the qu2 pattern).
            cpSync(warmAppDataDir, dir, { recursive: true });
          },
        },
        async (app) => {
          const s = app.session;
          coldAppDataDir = app.appDataDir;

          await s.byTestId("picker.root", { timeoutMs: 20_000 });
          await assertNoKeychainOnThisDevice(s);

          const rows = await s.byTestIdAll("picker.vault-row");
          expect(rows).toHaveLength(2);

          // The list reordered: the vault unlocked in launch 1 is now the most
          // recent, so it sits FIRST (SYNC-7 last-unlock ordering, which this
          // feature deliberately did not change).
          expect(await rows[0].attribute("data-vault-id")).toBe(second.vaultId);

          // …and its number did NOT reorder with it. Position 0, rank 2. This is
          // the whole of task 5: the name a user is asked to remember stopped
          // following the list.
          expect(await pickerRowText(s, second.vaultId)).toMatch(/^Vault 2/);
          expect(await pickerRowText(s, first.vaultId)).toMatch(/^Vault 1/);

          // No name on screen. On a device WITH a keychain this row would carry
          // the real name here; see the tripwire at the top of this file.
          for (const row of rows) {
            expect(await row.textContent()).not.toContain(VAULT_NAME);
          }
        },
      );

      // ---- Post-exit: what is actually on the two disks ---------------------
      await waitForFsQuiescence(warmDataHome);
      await waitForFsQuiescence(coldDataHome);

      // No sealed label file exists, in either tree, for either vault. A
      // keychain-less device seals nothing, so the picker's fallback above is
      // "there is nothing stored" and not "something is stored and unread".
      for (const base of [warmAppDataDir, coldAppDataDir]) {
        for (const v of [a, b]) {
          expect(existsSync(vaultLabelPath(base, v.vaultId))).toBe(false);
        }
      }

      // Positive control for the scanner itself: a planted copy of the needle
      // inside the scanned root is found. Without it, "no hits" could mean the
      // scan was pointed somewhere harmless.
      const canary = join(warmAppDataDir, "vl1-canary.bin");
      writeFileSync(canary, Buffer.from(VAULT_NAME, "utf8"));
      expect(scanForPlaintext(warmAppDataDir, [VAULT_NAME])).toEqual([
        { file: canary, needleIndex: 0, via: "content" },
      ]);
      rmSync(canary);

      // THE forbidden-fallback assertion. A keychain-less device must write the
      // name NOWHERE in the clear rather than degrade to plaintext, because a
      // plaintext copy looks identical on screen while voiding the per-vault
      // erase guarantee (`decisions.md` 2026-08-15, threat-model.md § 7).
      expect(scanForPlaintext(warmAppDataDir, [VAULT_NAME])).toEqual([]);
      expect(scanForPlaintext(coldAppDataDir, [VAULT_NAME])).toEqual([]);
    } finally {
      // Both launches kept their trees for the scans above; reaping them is this
      // spec's job, success or failure.
      for (const home of [warmDataHome, coldDataHome]) {
        if (home) rmSync(home, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  });
});

describeE2E("vl2 hide-vault-names sweeps the store and refuses a hollow flag (myne#411)", () => {
  // Vault-count precondition: 3 (weak KDF), each carrying a sealed-label file at
  // rest. ONE is unlocked, to reach Settings; the other TWO are never opened, and
  // they are the ones the sweep has to reach. Three rather than two because of
  // what the first container run of this scenario taught it, below.
  it("removes every vault.label from disk and writes no flag on a keychain-less device", async () => {
    let opened!: SeededVault;
    let untouched: SeededVault[] = [];
    let dataHome = "";
    let appDataDir = "";
    let flagPath = "";

    try {
      await scenario(
        "vl2-erase-on-enable",
        {
          keepDataDir: true,
          seed: (dir) => {
            dataHome = dirname(dir);
            opened = seedVault(dir, { password: PASSWORD_A });
            untouched = [
              seedVault(dir, { password: PASSWORD_B }),
              seedVault(dir, { password: PASSWORD_B }),
            ];
            for (const v of [opened, ...untouched]) {
              writeFileSync(vaultLabelPath(dir, v.vaultId), sealedLabelPlaceholder());
            }
          },
        },
        async (app) => {
          const s = app.session;
          appDataDir = app.appDataDir;
          flagPath = hideVaultNamesFlagPath(app.appConfigDir);

          const labelFile = (v: SeededVault) => vaultLabelPath(appDataDir, v.vaultId);
          const sweptFiles = untouched.map(labelFile);

          // Positive control 1: every fixture is on disk before anything runs, so
          // "gone" later cannot be vacuous.
          const allSeeded = [opened, ...untouched].map(labelFile);
          expect(allSeeded.filter((p) => existsSync(p))).toEqual(allSeeded);

          await s.byTestId("picker.root", { timeoutMs: 20_000 });
          await assertNoKeychainOnThisDevice(s);
          await selectPickerRow(s, opened.vaultId);
          await unlockToEditor(s, PASSWORD_A);
          await dismissImporterOffer(s);
          await openSettings(s, "privacy");

          const row = () => s.byTestId("settings.hide-vault-names");
          expect(await (await row()).attribute("data-keychain")).toBe("unavailable");
          expect(await (await row()).attribute("data-hidden")).toBe("false");
          // The row says the option cannot work here rather than appearing inert
          // (task 6). The switch stays interactive on purpose, which is what the
          // click below depends on.
          await s.byTestId("settings.hide-vault-names-unavailable");

          // What the first run of this scenario taught it, and it is worth
          // asserting rather than working around: UNLOCKING a vault that carries
          // no name removes that vault's sealed file. `persist_label_at` routes a
          // `None` label to `remove_label`, because "clearing a name is a removal,
          // never an empty string" is structural (task 4) and the post-unlock
          // pipeline applies it on every unlock. So the opened vault's fixture is
          // expected to be gone HERE, before the sweep has run at all.
          expect(existsSync(labelFile(opened))).toBe(false);

          // Positive control 2: the two vaults nobody opened still have theirs.
          // The boot's own `vault_list` read did NOT remove them: a dead KEY
          // deletes the orphan, an unavailable KEYCHAIN deletes nothing, because
          // the file is still openable on the day the secret service runs again
          // (task 6). Re-asserted here so the removal below can only be the
          // sweep's doing.
          expect(sweptFiles.filter((p) => existsSync(p))).toEqual(sweptFiles);

          const toggle = await s.byTestId("settings.hide-vault-names-toggle");
          await toggle.scrollIntoView();
          await toggle.click();

          // The completion signal is the sweep's own effect on the filesystem,
          // which is also the assertion: BOTH never-opened vaults lost their
          // sealed label file, so the sweep walks the disk (SYNC-10) rather than
          // the session. A no-op returns Ok and leaves both files where they were.
          await s.waitUntil(
            async () => (sweptFiles.every((p) => !existsSync(p)) ? true : null),
            {
              label: "every never-opened vault.label removed by the sweep",
              timeoutMs: 20_000,
            },
          );

          // …and the flag was NOT persisted. The erase runs BEFORE the write, so
          // a refused erase leaves nothing claiming an erase happened. This is
          // the disk-side form of it: the file the setter would have written does
          // not exist. Safe to assert immediately: the command that would have
          // written it has already returned (the files are gone).
          expect(existsSync(flagPath)).toBe(false);

          // Positive control 3, for the assertion immediately above: that path
          // and that writer are real. Turning the option OFF touches no keychain
          // at all, which is exactly what lets it succeed on a device that has
          // none, so it writes the file the refused enable did not. Driven from
          // the page seat because the UI can only reach `hidden: false` through a
          // switch that is currently on, and this one is off.
          await ipcOk(s, "plugin:vault-label|set_hide_vault_names", { hidden: false });
          await s.waitUntil(async () => (existsSync(flagPath) ? true : null), {
            label: "hide-vault-names flag file written",
            timeoutMs: 10_000,
          });
          expect(JSON.parse(readFileSync(flagPath, "utf8"))).toEqual({ hidden: false });

          // The switch never moved: nothing on screen reads "hidden" over keys
          // that were never touched.
          expect(await (await row()).attribute("data-hidden")).toBe("false");
          expect(
            await (await s.byTestId("settings.hide-vault-names-toggle")).attribute("aria-checked"),
          ).toBe("false");
          await closeSettings(s);
        },
      );

      // ---- Post-exit: the settled tree ---------------------------------------
      await waitForFsQuiescence(dataHome);
      for (const v of [opened, ...untouched]) {
        expect(existsSync(vaultLabelPath(appDataDir, v.vaultId))).toBe(false);
      }
      // Nothing on the way out flipped the flag to hidden either.
      expect(JSON.parse(readFileSync(flagPath, "utf8"))).toEqual({ hidden: false });
    } finally {
      if (dataHome) rmSync(dataHome, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
