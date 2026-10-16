// Flow-logic: Settings → Account → vault icon picker (vault-icons).
// Headless Chromium + mock IPC — NOT end-to-end. It covers the mobile half of
// the desktop parity gap: the icon was already syncing and already arriving on
// the wire, but nothing here rendered it and nothing here could set it.
//
// The load-bearing assertion in every write case is `vaultIconWrites`. The mock
// IPC table resolves an UNMOCKED command to `[]`, so a picker test that only
// checks the highlight would pass against its own optimistic draft with no
// command ever reaching the handler. Asserting the recorded write is what tells
// those two worlds apart.
//
// The second case is the one that makes the spec non-vacuous: reopening the
// sheet remounts it, which drops the optimistic draft, so a still-checked cell
// can only come from the stateful store answering the next `prefs_read`.
//
// What this tier CANNOT reach, and which therefore stays on the manual device
// checklist: the real Tauri ACL authorization (a missing permission fails closed
// only against a real host), the real `vault.prefs` write, and the RAM icon
// cache surviving a genuine lock → unlock.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";
import { closeSheet, vaultIconWrites } from "../helpers";

async function openAccount(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByTestId("settings.category-vault").click();
}

/** The app header's vault mark. `data-icon` is the resolved glyph name, or the
 *  literal "wordmark" for the neutral fallback. */
function headerMark(page: Page) {
  return page.getByTestId("workspace.vault-mark");
}

function iconOption(page: Page, name: string) {
  return page.locator(`[data-testid="settings.icon-option"][data-icon-name="${name}"]`);
}

test.describe("mobile vault-icon picker", () => {
  test("picking a glyph writes it and the header mark projects it", async ({ page }) => {
    await installMockIpc(page);
    await page.goto("/");

    await expect(headerMark(page)).toHaveAttribute("data-icon", "wordmark");

    await openAccount(page);
    await expect(page.getByTestId("settings.icon-picker")).toBeVisible();
    await iconOption(page, "book").click();

    // The real command fired — not the unknown-command catch-all.
    await expect.poll(() => vaultIconWrites(page)).toEqual(["book"]);
    await expect(iconOption(page, "book")).toHaveAttribute("aria-checked", "true");
    await expect(iconOption(page, "default")).toHaveAttribute("aria-checked", "false");

    await closeSheet(page);
    await expect(headerMark(page)).toHaveAttribute("data-icon", "book");
  });

  test("the choice survives a sheet remount, so it is disk truth not the draft", async ({ page }) => {
    await installMockIpc(page);
    await page.goto("/");

    await openAccount(page);
    await iconOption(page, "star").click();
    await expect.poll(() => vaultIconWrites(page)).toEqual(["star"]);

    // Remount drops the optimistic draft; only the stateful store can answer.
    await closeSheet(page);
    await openAccount(page);
    await expect(iconOption(page, "star")).toHaveAttribute("aria-checked", "true");
  });

  test("Default clears the glyph back to the wordmark", async ({ page }) => {
    await installMockIpc(page, { prefs: { icon: "book" } });
    await page.goto("/");

    await expect(headerMark(page)).toHaveAttribute("data-icon", "book");

    await openAccount(page);
    await expect(iconOption(page, "book")).toHaveAttribute("aria-checked", "true");
    await iconOption(page, "default").click();

    await expect.poll(() => vaultIconWrites(page)).toEqual([null]);
    await expect(iconOption(page, "default")).toHaveAttribute("aria-checked", "true");

    await closeSheet(page);
    await expect(headerMark(page)).toHaveAttribute("data-icon", "wordmark");
  });

  test("re-picking the already-active glyph writes nothing", async ({ page }) => {
    await installMockIpc(page, { prefs: { icon: "book" } });
    await page.goto("/");

    await openAccount(page);
    await iconOption(page, "book").click();

    await expect(iconOption(page, "book")).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => vaultIconWrites(page)).toEqual([]);
  });

  test("the switcher row shows the active vault's glyph", async ({ page }) => {
    // Deliberately NOT `multiVault`: that config reports an Empty slot, which
    // boots to the pre-unlock picker, so EditorFlow and the switcher never
    // mount. The single-vault default is the unlocked one — and it is also the
    // only vault that CAN carry a glyph (SYNC-1 + SYNC-3).
    await installMockIpc(page, { prefs: { icon: "book" } });
    await page.goto("/");

    await headerMark(page).click();
    const row = page.getByTestId("switcher.vault-row").first();
    await expect(row).toBeVisible();
    await expect(row.getByTestId("switcher.vault-mark")).toHaveAttribute("data-icon", "book");
  });

  test("an unknown glyph name falls back to the wordmark and checks nothing", async ({ page }) => {
    // A name from a newer client this build does not know. It must render the
    // wordmark rather than an empty ink square, and it must NOT be normalized
    // away — `icon` is Shared(ScalarLww), so rewriting it would clobber the
    // newer choice on the next merge.
    await installMockIpc(page, { prefs: { icon: "not-a-real-glyph" } });
    await page.goto("/");

    await expect(headerMark(page)).toHaveAttribute("data-icon", "wordmark");

    await openAccount(page);
    await expect(page.getByTestId("settings.icon-picker")).toBeVisible();
    await expect(page.locator('[data-testid="settings.icon-option"][aria-checked="true"]')).toHaveCount(0);
    await expect.poll(() => vaultIconWrites(page)).toEqual([]);
  });
});
