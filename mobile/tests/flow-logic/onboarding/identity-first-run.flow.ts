// Flow-logic: the phone's ONE-DOOR first run (myne-md/myne#911 task 12).
// Headless Chromium + mock IPC: NOT end-to-end (no real Argon2id, no on-disk
// vault). What IS flow-testable here is the chain itself and its two claims:
//
//   1. The welcome screen has ONE create action. The identity/local fork is gone,
//      so a phone cannot mint a per-vault recovery phrase the person account
//      exists to retire.
//   2. The identity is created with NO server step in the chain. This is the
//      "a phone completes an offline first run" half of the task's acceptance:
//      before this change the gate's create door went to an endpoint form whose
//      Continue was disabled until a URL was typed, so a phone with no server
//      could not get an identity at all.
//   3. The identity home hands off to vault creation, which is the next step of
//      the same run rather than a separate door on the welcome screen.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";
import { createIdentityToHome, startVaultFromIdentityHome, IDENTITY_SETUP_RESULT } from "../helpers";

test.describe("mobile one-door first run (myne-md/myne#911 task 12)", () => {
  test("welcome offers ONE create action, and the local-vault fork is gone", async ({ page }) => {
    await installMockIpc(page, { freshDevice: true });
    await page.goto("/");

    await expect(page.getByTestId("welcome.create-cta")).toBeVisible();
    // The door that used to sit beside it. Absent rather than renamed: a phone
    // that can create a vault without an identity is the two-phrase model the
    // person account removes, and desktop does not offer it either.
    await expect(
      page.getByRole("button", { name: "Create a local vault instead" }),
    ).toHaveCount(0);
    // The join door stays: adding this device to an account that already exists is
    // not a create.
    await expect(page.getByTestId("welcome.join-cta")).toBeVisible();
  });

  test("offline first run: identity with no server step, then the identity home creates the vault", async ({
    page,
  }) => {
    await installMockIpc(page, {
      freshDevice: true,
      personSetupResult: IDENTITY_SETUP_RESULT,
    });
    await page.goto("/");

    // The whole ceremony, and the assertion that matters is the one the helper
    // makes on the way: `identity-flow.create` is reachable without ever seeing
    // `identity-flow.server-input`.
    await createIdentityToHome(page);
    await expect(page.getByTestId("identity-flow.server-input")).toHaveCount(0);

    // The identity exists and is `reserved` (created with no server account), so
    // the home offers registration beside the vault action. Both are explicit.
    await expect(page.getByTestId("identity-flow.home-register-open")).toBeVisible();
    await expect(page.getByTestId("identity-flow.home-create-vault")).toBeVisible();

    // …and the vault action is the exit into vault creation, which is where the
    // one-door run continues: the flow opens on the first-run safety briefing.
    await startVaultFromIdentityHome(page);
    await expect(page.getByTestId("create-vault.briefing-why").first()).toBeVisible();
  });

  test("registering from the identity home names the server first, then sends the phrase", async ({
    page,
  }) => {
    await installMockIpc(page, {
      freshDevice: true,
      personSetupResult: IDENTITY_SETUP_RESULT,
    });
    await page.goto("/");
    await createIdentityToHome(page);

    await page.getByTestId("identity-flow.home-register-open").click();

    // The server comes FIRST (2026-10-24). The step used to collect 24 words and
    // then, on `NotConfigured`, tell the user to set a server in Settings — a
    // screen with no door before the first vault exists. The address row is on
    // the step, and nothing can be submitted without it.
    const server = page.getByTestId("identity-flow.register-server");
    await expect(server).toBeVisible();
    await expect(server).toHaveValue("");

    // No address, no way forward, and the phrase is not on this step at all.
    await expect(page.getByTestId("identity-flow.register-continue")).toBeDisabled();
    await expect(page.locator('input[data-testid^="identity-flow.register-cell"]')).toHaveCount(0);

    await server.fill("https://sync.example");
    await page.getByTestId("identity-flow.register-continue").click();

    // Step two is the phrase.
    const cells = page.locator('input[data-testid^="identity-flow.register-cell"]');
    await expect(cells).toHaveCount(24);
    for (let i = 0; i < 24; i += 1) {
      await cells.nth(i).fill("ribbon");
    }
    await page.getByTestId("identity-flow.register-submit").click();

    // The address went first, then the phrase crossed IPC once as the proof of
    // possession.
    const endpointArgs = await page.evaluate(
      () =>
        (window as unknown as { __setEndpointArgs?: { endpointUrl?: string }[] })
          .__setEndpointArgs,
    );
    expect(endpointArgs?.[0]?.endpointUrl).toBe("https://sync.example");
    const args = await page.evaluate(
      () => (window as unknown as { __personRegisterArgs?: { phrase?: string } }).__personRegisterArgs,
    );
    expect(typeof args?.phrase).toBe("string");
    expect((args?.phrase ?? "").split(" ")).toHaveLength(24);

    // Back on the home, with the registration block gone: the state is re-probed
    // rather than assumed, and it now reads `enrolled`.
    await expect(page.getByTestId("identity-flow.home-create-vault")).toBeVisible();
    await expect(page.getByTestId("identity-flow.home-register-open")).toHaveCount(0);
  });
});
