// Flow-logic: the custom theme across the LOCK BOUNDARY (MYND-598 task 5).
// Headless Chromium + mock IPC — NOT end-to-end. The other custom-themes spec
// drives the Appearance panel; this one drives the two moments the panel never
// reaches, and both of them need the password-unlock path (`lockedVault`) — the
// default harness boots straight into the editor with the slot already Unlocked
// and would never exercise either.
//
// What is being pinned down:
//
//   - The palette is on the root BEFORE the editor's first frame, not after it.
//     Asserted as an ORDER, not a coincidence: a MutationObserver installed
//     before boot records which of the two happened first.
//   - Nothing custom is on the root while the lock screen is up, and locking
//     takes every property back. A palette is vault content; someone who picks
//     up the locked phone must learn nothing from the way it looks.
//   - A selection naming a theme that is gone (deleted on the computer, deletion
//     synced here) falls back to the built-in choice in silence AND never writes
//     the preference back. Not rewriting it is what preserves revival: a desktop
//     re-add clears the tombstone and the next sync restores the theme.
//   - The palette lands on EVERY route into the editor, not just the password
//     one. `stage.ts` reaches `{name:"editor"}` from four transitions plus the
//     boot probe's already-`Unlocked` short-circuit; the two covered below are
//     the ones that can open a vault already carrying a selection — recovery
//     from the phrase, and a WebView reload over a live Rust slot. (The other
//     two — sync-join and create-vault auto-unlock — start from a vault with no
//     themes yet, and ride the same single gate in `AppShell.enterStage`.)

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";
import { customThemeWrites, rootCustomProps, SEEDED_THEMES } from "../helpers";

/**
 * Record, from before the app boots, whether the palette or the editor appeared
 * first. One observer, one append-once list: `palette` is marked when `--paper`
 * first lands inline on `<html>`, `editor` when the editor's header first exists
 * in the DOM. The paint is awaited ahead of the stage dispatch, so a regression
 * that fires the dispatch first flips this list — which a "is the palette there
 * now?" assertion after the fact could never catch.
 *
 * Observing `document` rather than `document.documentElement` is load-bearing:
 * an init script runs at document-start, where `documentElement` is still null,
 * so observing it throws and leaves a silently empty list. `subtree: true` on
 * the document node covers the root element's own attribute changes.
 */
async function recordPaintOrder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const order: string[] = [];
    (window as unknown as { __paintOrder?: string[] }).__paintOrder = order;
    const mark = (k: string) => {
      if (!order.includes(k)) order.push(k);
    };
    new MutationObserver(() => {
      if (document.documentElement?.style.getPropertyValue("--paper")) mark("palette");
      if (document.querySelector('[data-testid="workspace.app-header"]')) mark("editor");
    }).observe(document, { attributes: true, attributeFilter: ["style"], childList: true, subtree: true });
  });
}

/** Seed the built-in theme boot cache, so "the built-in choice was applied" is
 *  an observable `data-theme="dark"` rather than the indistinguishable
 *  attribute-absent state that both "system" and a custom theme produce. */
async function seedBuiltInChoice(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("myne.theme", "dark"));
}

async function unlock(page: Page): Promise<void> {
  await page.getByTestId("unlock-password").fill("correct horse battery staple");
  await page.getByTestId("unlock-submit").click();
}

test.describe("mobile custom-themes across the lock boundary", () => {
  test("stored selection → painted before the editor renders, gone again on lock", async ({ page }) => {
    await installMockIpc(page, {
      lockedVault: true,
      customThemes: SEEDED_THEMES,
      prefs: { custom_theme: "Zinc" },
    });
    await seedBuiltInChoice(page);
    await recordPaintOrder(page);
    await page.goto("/");

    // Lock screen: the vault is closed, so nothing of it is on the root.
    await expect(page.getByTestId("unlock-submit")).toBeVisible();
    expect(await rootCustomProps(page)).toEqual({});

    await unlock(page);
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();

    const applied = await rootCustomProps(page);
    expect(applied["--paper"]).toBe("#101014");
    expect(applied["--accent"]).toBe("#7aa2f7");
    // The dark palette's syntax roles come from the shared derivation, so the
    // unlock path goes through the same applier the Appearance tap uses.
    expect(applied["--syntax-keyword"]).toBe("var(--_syntax-keyword-dark)");
    // Painted first, editor second — the editor never rendered a frame under the
    // built-in appearance.
    expect(await page.evaluate(() => (window as unknown as { __paintOrder: string[] }).__paintOrder)).toEqual([
      "palette",
      "editor",
    ]);
    // A custom theme supersedes the built-in choice: editor mount must NOT put
    // `data-theme="dark"` back on, even though the boot cache says dark.
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBeNull();

    // Lock from Settings → back on the lock screen wearing nothing.
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByRole("button", { name: "Lock vault" }).click();
    await expect(page.getByTestId("unlock-submit")).toBeVisible();
    expect(await rootCustomProps(page)).toEqual({});
  });

  test("selection naming a theme that is gone → built-in choice, preference untouched", async ({ page }) => {
    await installMockIpc(page, {
      lockedVault: true,
      customThemes: SEEDED_THEMES,
      prefs: { custom_theme: "Solarized" },
    });
    await seedBuiltInChoice(page);
    await page.goto("/");

    await unlock(page);
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();

    // No palette, and the built-in choice really was applied — not merely absent.
    expect(await rootCustomProps(page)).toEqual({});
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
    // Silent: no toast about a colour scheme the user cannot act on.
    await expect(page.getByText("Solarized")).toHaveCount(0);
    // And the dangling name stays on disk — the revival property, spelled out
    // in this file's header and in `resolveCustomPalette`.
    expect(await customThemeWrites(page)).toEqual([]);

    // Locking reverts the custom palette and ONLY the custom palette: the
    // built-in `data-theme` attribute survives the lock exactly as it did before
    // this feature. That mobile keeps a light/dark attribute on a locked screen
    // is a pre-existing divergence from the normative clear-on-lock claim, owed
    // its own work item — this asserts the boundary rather than widening to fix
    // it, so a later change cannot silently absorb it into the custom-theme path.
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByRole("button", { name: "Lock vault" }).click();
    await expect(page.getByTestId("unlock-submit")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
  });

  // Recovery from the phrase opens an EXISTING vault, so it can carry both a
  // `custom_theme` selection and the themes it names — the same state the
  // password route lands in, reached by a different transition. It was the
  // route the first cut of this feature missed: the editor rendered under the
  // built-in appearance and stayed there until the next lock/unlock cycle, at
  // which point the theme appeared with no explanation.
  test("recovery from the phrase lands the editor already wearing the palette", async ({ page }) => {
    await installMockIpc(page, {
      lockedVault: true,
      customThemes: SEEDED_THEMES,
      prefs: { custom_theme: "Zinc" },
    });
    await seedBuiltInChoice(page);
    await recordPaintOrder(page);
    await page.goto("/");

    await page.getByTestId("unlock-recovery-link").click();

    // Account step (optional) → phrase grid → the non-dismissible reset. The
    // mock accepts any 24 words; the real BIP-39 → Argon2id work is a device
    // check (`recover/phrase-reset.flow.ts` owns the flow itself).
    const accountContinue = page.getByRole("button", { name: "Continue" });
    if (await accountContinue.isVisible().catch(() => false)) {
      const inputs = page.locator("input");
      if ((await inputs.count()) === 1) await accountContinue.click();
    }
    const cells = page.locator("input");
    await expect(cells).toHaveCount(24);
    for (let i = 0; i < 24; i++) await cells.nth(i).fill("ribbon");
    await page.getByRole("button", { name: /^Submit/ }).click();

    const pw = page.locator('input[type="password"]');
    await expect(pw).toHaveCount(2);
    await pw.nth(0).fill("correct horse battery staple");
    await pw.nth(1).fill("correct horse battery staple");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByTestId("workspace.app-header")).toBeVisible();

    const applied = await rootCustomProps(page);
    expect(applied["--paper"]).toBe("#101014");
    expect(applied["--accent"]).toBe("#7aa2f7");
    // Painted first, editor second — same ordering guarantee as the password
    // route, because both go through the one gate rather than two call sites.
    expect(await page.evaluate(() => (window as unknown as { __paintOrder: string[] }).__paintOrder)).toEqual([
      "palette",
      "editor",
    ]);
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBeNull();
  });

  // The boot probe's already-`Unlocked` short-circuit: the Rust slot outlives
  // the JS runtime, so a WebView reload (the dev loop; Android activity
  // recreation) re-enters the editor without any unlock screen in between.
  test("boot over a live Unlocked slot paints before the editor renders", async ({ page }) => {
    await installMockIpc(page, {
      customThemes: SEEDED_THEMES,
      prefs: { custom_theme: "Zinc" },
    });
    await seedBuiltInChoice(page);
    await recordPaintOrder(page);
    await page.goto("/");

    await expect(page.getByTestId("workspace.app-header")).toBeVisible();

    const applied = await rootCustomProps(page);
    expect(applied["--paper"]).toBe("#101014");
    expect(applied["--syntax-keyword"]).toBe("var(--_syntax-keyword-dark)");
    expect(await page.evaluate(() => (window as unknown as { __paintOrder: string[] }).__paintOrder)).toEqual([
      "palette",
      "editor",
    ]);
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBeNull();
  });
});
