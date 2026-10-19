// Flow-logic: the fresh-device "Connect to my account" join flow (MYND-459 /
// MYND-462 T3). Drives headless Chromium against the dev server with mock IPC —
// NOT an end-to-end suite (no device, no Rust, no real transport). Boots to
// Welcome (freshDevice), enters the join flow, submits {server, account#,
// password}, and — since the mock join returns `pending: true` — asserts the
// pending-approval screen, then "Continue" lands the editor.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

test.describe("sync join flow", () => {
  test("Welcome → Connect to my account → pending → editor", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      joinResult: {
        vault_id: "flow-vault",
        pending: true,
        fingerprint: null,
        device_id_hex: "aa11bb22cc33dd44ee55ff6677889900",
      },
      devicePlatform: "ios",
      // sync_head_fingerprint returns a value → the pending poll advances to verify.
      headFingerprint: "TYRS-N318",
      syncStatus: { state: "pending" },
    });
    await page.goto("/");

    // Welcome offers the new entry; open the join flow.
    await page.getByRole("button", { name: "Connect to my account" }).click();
    await expect(page.getByTestId("sync.join")).toBeVisible();

    // MYND-548: the join door carries the same pre-filled name field the Settings
    // enrollment panel does — a device arriving through this one nameless would be
    // a silent regression no other test would catch.
    await expect(page.getByTestId("sync.join.device-name-input")).toHaveValue("iPhone");
    await page.getByTestId("sync.join.device-name-input").fill("New phone");

    await page.getByTestId("sync.join.server-input").fill("https://sync.example.com");
    await page.getByTestId("sync.join.account-input").fill("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");
    await page.getByTestId("sync.join.password-input").fill("correct horse battery staple");
    await page.getByTestId("sync.join.submit").click();

    // Password join → pending; the poll picks up the adopted-head fingerprint and
    // advances to the mandatory SYNC-40 verify step showing the SAS code.
    await expect(page.getByTestId("sync.join.verify")).toBeVisible();
    await expect(page.getByTestId("sync.join.sas-fingerprint")).toHaveText("TYRS-N318");

    // "They match" dispatches welcome.join-success → editor mounts (main surface up).
    await page.getByTestId("sync.join.sas-match").click();
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
  });

  test("wrong account → the single non-distinguishing banner", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      joinError: { kind: "BadRequest" }, // account/password/existence all collapse
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Connect to my account" }).click();

    await page.getByTestId("sync.join.server-input").fill("https://sync.example.com");
    await page.getByTestId("sync.join.account-input").fill("MY-0000-0000-0000-0000-0000");
    await page.getByTestId("sync.join.password-input").fill("whatever");
    await page.getByTestId("sync.join.submit").click();

    await expect(page.getByTestId("sync.join.error")).toBeVisible();
  });

  // ── Device-join via QR (MYND-466) ──────────────────────────────────────────
  test("Scan QR → confirm → prefilled form → pending", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      qrScan: { value: "MYQR1|https://sync.example.com|4K7P9RH2JR3T8XW6VZ0A|-|9999999999" },
      qrDecode: {
        kind: "account",
        endpoint_url: "https://sync.example.com",
        account_number: "4K7P9RH2JR3T8XW6VZ0A",
        fresh: true,
      },
      joinResult: { vault_id: "flow-vault", pending: true, fingerprint: null },
      headFingerprint: "TYRS-N318",
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Connect to my account" }).click();

    // Scan → confirm screen shows the decoded server + account#.
    await page.getByTestId("sync.join.scan-qr").click();
    await expect(page.getByTestId("sync.join.qr-confirm")).toBeVisible();
    await expect(page.getByTestId("sync.join.qr-confirm.server")).toHaveText("https://sync.example.com");
    await expect(page.getByTestId("sync.join.qr-confirm.account")).toHaveText("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");

    // Continue → back to the form, server + account prefilled; only the password left.
    await page.getByTestId("sync.join.qr-confirm.continue").click();
    await expect(page.getByTestId("sync.join.server-input")).toHaveValue("https://sync.example.com");
    await expect(page.getByTestId("sync.join.account-input")).toHaveValue("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");

    await page.getByTestId("sync.join.password-input").fill("correct horse battery staple");
    await page.getByTestId("sync.join.submit").click();
    await expect(page.getByTestId("sync.join.verify")).toBeVisible();
  });

  test("expired QR → re-scan message, no confirm step", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      qrScan: { value: "MYQR1|https://sync.example.com|4K7P9RH2JR3T8XW6VZ0A|-|1" },
      qrDecode: {
        kind: "account",
        endpoint_url: "https://sync.example.com",
        account_number: "4K7P9RH2JR3T8XW6VZ0A",
        fresh: false,
      },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Connect to my account" }).click();
    await page.getByTestId("sync.join.scan-qr").click();
    await expect(page.getByTestId("sync.join.error")).toBeVisible();
    await expect(page.getByTestId("sync.join.qr-confirm")).toHaveCount(0);
  });

  test("non-Myne QR → error, stays on the form", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      qrScan: { value: "https://evil.example" },
      qrDecodeError: { kind: "NotAQrJoinPayload" },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Connect to my account" }).click();
    await page.getByTestId("sync.join.scan-qr").click();
    await expect(page.getByTestId("sync.join.error")).toBeVisible();
    await expect(page.getByTestId("sync.join.qr-confirm")).toHaveCount(0);
  });

  // myne-md/myne#557, the `enrolment.qr-scan` bullet:
  //
  //   > both halves are code: the Rust arm returns `Error::Unsupported` off iOS
  //   > and `JoinFlow.tsx` maps `errKind === "Unsupported"` to
  //   > `t("join.qr.scanUnavailable")`, so making the mocked IPC return
  //   > `Unsupported` and asserting that message IS the "button that appears to
  //   > do nothing" check.
  //
  // The scanner plugin has an iOS arm and nothing else — `Error::Unsupported` on
  // Android and on any desktop-hosted shell — so this branch is what the
  // MAJORITY of installs take. It is also the branch a hand-walk on an iPhone
  // structurally cannot reach, and the failure it guards against is silent:
  // without the mapping the catch falls through to `qrErrorMessage`'s default,
  // "Couldn't scan", which tells an Android user their camera failed and invites
  // them to try again forever. The correct message tells them scanning is not a
  // thing here and points at the form that is.
  //
  // Asserted by LITERAL, because the whole defect is which of two messages
  // rendered — a visible-error assertion passes on either one. The Rust half is
  // pinned separately in
  // `mobile/src-tauri/tauri-plugin-qr-scan/tests/unsupported_contract.rs`.
  test("scanner unavailable → says so, and leaves the form usable", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      qrScanError: { kind: "Unsupported" },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Connect to my account" }).click();
    await page.getByTestId("sync.join.scan-qr").click();

    await expect(page.getByTestId("sync.join.error")).toHaveText(
      "Scanning isn’t available on this device. Enter your details below.",
    );
    // Not the generic scan failure, which would read as "your camera didn't
    // work, try again" on a device where trying again can never work.
    await expect(page.getByTestId("sync.join.error")).not.toHaveText(
      "Couldn’t scan. Try again, or enter your details manually.",
    );

    // The message points at the form, so the form has to still be there and
    // still work. A refusal that also disabled the manual path would be a
    // dead end rather than a redirect.
    await expect(page.getByTestId("sync.join.qr-confirm")).toHaveCount(0);
    await page.getByTestId("sync.join.server-input").fill("https://sync.example.com");
    await page.getByTestId("sync.join.account-input").fill("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");
    await page.getByTestId("sync.join.password-input").fill("correct horse battery staple");
    await expect(page.getByTestId("sync.join.submit")).toBeEnabled();
  });

  // ── The join door on a device that ALREADY holds vaults (myne-mobile#40) ────
  //
  // The regression these two cover is not inside JoinFlow — it is that nothing
  // could reach it. `welcome` is produced only at zero vaults, so once a vault
  // existed the flow was unreachable short of deleting every vault. Each spec
  // asserts the entry is PRESENT and that it lands the editor, because the
  // missing entry is the whole bug.

  test("picker → Connect to my account → pending → editor", async ({ page }) => {
    await installMockIpc(page, {
      // ≥2 vaults with an Empty slot → boots to the picker, never to Welcome.
      multiVault: true,
      joinResult: {
        vault_id: "joined-vault",
        pending: true,
        fingerprint: null,
        device_id_hex: "aa11bb22cc33dd44ee55ff6677889900",
      },
      headFingerprint: "TYRS-N318",
      syncStatus: { state: "pending" },
    });
    await page.goto("/");

    await expect(page.getByText("Choose a vault")).toBeVisible();
    await page.getByTestId("picker.join-account").click();
    await expect(page.getByTestId("sync.join")).toBeVisible();

    await page.getByTestId("sync.join.server-input").fill("https://sync.example.com");
    await page.getByTestId("sync.join.account-input").fill("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");
    await page.getByTestId("sync.join.password-input").fill("correct horse battery staple");
    await page.getByTestId("sync.join.submit").click();

    await expect(page.getByTestId("sync.join.verify")).toBeVisible();
    await page.getByTestId("sync.join.sas-match").click();

    // picker.join-success → the joined vault's editor. Reaching it at all is the
    // assertion: this config's slot is Empty, so nothing but the join can.
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
  });

  // ── The recovery-phrase arm (myne-md/myne#837) ─────────────────────────────
  //
  // The mobile client had no phrase path at all: `JoinFlow` said "Password-only
  // (the 24-word-phrase variant is the deferred F3-T5 follow-up)" while the
  // desktop half shipped it. These two specs drive the two surfaces the issue
  // asks for, and, because the mock records the argument, hold the ONE thing
  // the UI cannot show: which credential reached `sync_join_account`, and
  // whether it is the normalised phrase rather than the raw cells.
  // ONE cell is spelled the way a phone keyboard produces it, so the wire
  // assertion below can fail on a dropped normaliser: 24 copies of "abandon"
  // are byte-identical before and after `normalizeBip39Phrase`, which made the
  // original fixture unable to hold the defect it claimed to pin.
  const PHRASE_WORDS = ["ABANDON", ...Array.from({ length: 23 }, () => "abandon")];
  const PHRASE_CREDENTIAL = PHRASE_WORDS.map((w) => w.toLowerCase()).join(" ");

  test("recovery phrase join → chained password reset", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      // A phrase join self-approves and leaves the vault `Recovering`, so the
      // result carries `needs_password_reset` rather than `pending`.
      joinResult: {
        vault_id: "joined-vault",
        pending: false,
        fingerprint: null,
        needs_password_reset: true,
      },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Connect to my account" }).click();
    await expect(page.getByTestId("sync.join")).toBeVisible();

    await page.getByTestId("sync.join.server-input").fill("https://sync.example.com");
    await page.getByTestId("sync.join.account-input").fill("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");

    // Switch to the phrase credential; the password field yields to the grid,
    // and so does the approval hint: a phrase join self-approves, so telling
    // this user to wait for another device names a request nobody makes.
    await expect(page.getByTestId("sync.join.approval-hint")).toBeVisible();
    await page.getByTestId("sync.join.mode-recovery").click();
    await expect(page.getByTestId("sync.join.phrase-grid")).toBeVisible();
    await expect(page.getByTestId("sync.join.password-input")).toHaveCount(0);
    await expect(page.getByTestId("sync.join.approval-hint")).toHaveCount(0);

    for (let i = 0; i < PHRASE_WORDS.length; i++) {
      await page.getByTestId("sync.join.phrase-cell").nth(i).fill(PHRASE_WORDS[i]);
    }
    await page.getByTestId("sync.join.submit").click();

    // The ONE difference the wire shape cannot show: the Rust command names the
    // argument `password` either way, so `credentialKind` is the whole of it.
    const args = await page.evaluate(
      () => (window as unknown as { __joinArgs?: { credentialKind?: string; password?: string } }).__joinArgs,
    );
    expect(args?.credentialKind).toBe("recovery");
    expect(args?.password).toBe(PHRASE_CREDENTIAL);

    // A `Recovering` vault is not an unlocked one: the shell must land on the
    // chained password reset, not on an editor that would fail closed.
    await expect(page.getByTestId("recover.password-reset")).toBeVisible();

    // And the reset must commit against the vault the join just bootstrapped.
    // On a device already holding vaults the sole-vault fallback cannot
    // resolve, so a lost id strands this vault in `Slot::Recovering` while the
    // screen reports a reset failure.
    const reset = page.getByTestId("recover.password-reset").locator("input");
    await reset.nth(0).fill("a brand new password");
    await reset.nth(1).fill("a brand new password");
    await reset.nth(1).press("Enter");
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __completeRecoveryArgs?: { vaultId?: string } }).__completeRecoveryArgs,
        ),
      )
      .toMatchObject({ vaultId: "joined-vault" });
  });

  test("pending → escape with the phrase → editor", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      joinResult: {
        vault_id: "joined-vault",
        pending: true,
        fingerprint: null,
        device_id_hex: "aa11bb22cc33dd44ee55ff6677889900",
        needs_password_reset: false,
      },
      // An array is the only spelling the mock takes literally: a bare `null`
      // falls back to its default fingerprint, which would advance the pending
      // screen to the SAS compare before the escape could be taken.
      headFingerprint: [null, null],
      enrollResult: { approved: true, device_id_hex: "bb11cc22dd33ee44ff55667788990011" },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Connect to my account" }).click();

    await page.getByTestId("sync.join.server-input").fill("https://sync.example.com");
    await page.getByTestId("sync.join.account-input").fill("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");
    await page.getByTestId("sync.join.password-input").fill("correct horse battery staple");
    await page.getByTestId("sync.join.submit").click();

    // Waiting for an approval nobody is left to give: the escape is offered.
    await expect(page.getByTestId("sync.join.pending")).toBeVisible();
    await page.getByTestId("sync.join.use-phrase").click();
    await expect(page.getByTestId("sync.join.pending-phrase")).toBeVisible();

    for (let i = 0; i < PHRASE_WORDS.length; i++) {
      await page.getByTestId("sync.join.pending-phrase-cell").nth(i).fill(PHRASE_WORDS[i]);
    }
    await page.getByTestId("sync.join.phrase-submit").click();

    // Approved on the recovery path, so there is no second device to compare
    // against and the device goes straight in.
    const enrollArgs = await page.evaluate(
      () => (window as unknown as { __enrollArgs?: { credentialKind?: string; credential?: string } }).__enrollArgs,
    );
    expect(enrollArgs?.credentialKind).toBe("recovery");
    expect(enrollArgs?.credential).toBe(PHRASE_CREDENTIAL);
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
  });

  test("escape with a refused phrase: one non-distinguishing banner, cells kept", async ({
    page,
  }) => {
    await installMockIpc(page, {
      freshDevice: true,
      joinResult: {
        vault_id: "joined-vault",
        pending: true,
        fingerprint: null,
        device_id_hex: "aa11bb22cc33dd44ee55ff6677889900",
        needs_password_reset: false,
      },
      headFingerprint: [null, null],
      // The escape re-enrols with the phrase instead of waiting; a refusal must
      // be the SAME banner the form shows, so a typo cannot become an oracle.
      enrollError: { kind: "BadRequest" },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Connect to my account" }).click();
    await page.getByTestId("sync.join.server-input").fill("https://sync.example.com");
    await page.getByTestId("sync.join.account-input").fill("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");
    await page.getByTestId("sync.join.password-input").fill("correct horse battery staple");
    await page.getByTestId("sync.join.submit").click();
    await expect(page.getByTestId("sync.join.pending")).toBeVisible();
    await page.getByTestId("sync.join.use-phrase").click();
    for (let i = 0; i < PHRASE_WORDS.length; i++) {
      await page.getByTestId("sync.join.pending-phrase-cell").nth(i).fill(PHRASE_WORDS[i]);
    }
    await page.getByTestId("sync.join.phrase-submit").click();

    await expect(page.getByTestId("sync.join.phrase-error")).toBeVisible();
    // The grid survives a refusal, so the user can correct the one bad cell
    // rather than retyping all 24.
    await expect(page.getByTestId("sync.join.pending-phrase-cell").first()).toBeVisible();
  });

  test("escape with a phrase the server did not self-approve: still pending, said so", async ({
    page,
  }) => {
    await installMockIpc(page, {
      freshDevice: true,
      joinResult: {
        vault_id: "joined-vault",
        pending: true,
        fingerprint: null,
        device_id_hex: "aa11bb22cc33dd44ee55ff6677889900",
        needs_password_reset: false,
      },
      headFingerprint: [null, null],
      enrollResult: { approved: false, device_id_hex: "bb11cc22dd33ee44ff55667788990011" },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Connect to my account" }).click();
    await page.getByTestId("sync.join.server-input").fill("https://sync.example.com");
    await page.getByTestId("sync.join.account-input").fill("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");
    await page.getByTestId("sync.join.password-input").fill("correct horse battery staple");
    await page.getByTestId("sync.join.submit").click();
    await expect(page.getByTestId("sync.join.pending")).toBeVisible();
    await page.getByTestId("sync.join.use-phrase").click();
    for (let i = 0; i < PHRASE_WORDS.length; i++) {
      await page.getByTestId("sync.join.pending-phrase-cell").nth(i).fill(PHRASE_WORDS[i]);
    }
    await page.getByTestId("sync.join.phrase-submit").click();

    // A server that does not self-approve the recovery path is a state this
    // client must surface rather than silently land in an empty editor.
    await expect(page.getByTestId("sync.join.phrase-still-pending")).toBeVisible();
  });

  test("vault switcher → Connect to my account → pending → editor", async ({ page }) => {
    // Deliberately NOT `multiVault` (its Empty slot boots to the picker, so the
    // editor and its switcher never mount) — the default config is the unlocked
    // single vault, which is exactly the user in the bug report: one local vault,
    // no picker, and until now no way back to the join flow.
    await installMockIpc(page, {
      joinResult: {
        vault_id: "joined-vault",
        pending: true,
        fingerprint: null,
        device_id_hex: "aa11bb22cc33dd44ee55ff6677889900",
      },
      headFingerprint: "TYRS-N318",
      syncStatus: { state: "pending" },
    });
    await page.goto("/");

    await page.getByTestId("workspace.vault-mark").click();
    await expect(page.getByTestId("switcher.vault-row").first()).toBeVisible();
    await page.getByTestId("switcher.join-account").click();
    await expect(page.getByTestId("sync.join")).toBeVisible();

    await page.getByTestId("sync.join.server-input").fill("https://sync.example.com");
    await page.getByTestId("sync.join.account-input").fill("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");
    await page.getByTestId("sync.join.password-input").fill("correct horse battery staple");
    await page.getByTestId("sync.join.submit").click();

    await expect(page.getByTestId("sync.join.verify")).toBeVisible();
    await page.getByTestId("sync.join.sas-match").click();

    // editor.join-success re-addresses the editor at the joined vault; the sheet
    // is gone and the main surface is back up.
    await expect(page.getByTestId("switcher.vault-row")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
  });
});
