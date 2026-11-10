// Shared helpers for the flow-logic tier.
//
// These exist because the gestures below are not expressible as a plain
// Playwright action against this app, and more than one spec needs each:
//
//   • `longPress` — the row action sheets open on a 480ms hold, and Playwright's
//     `click()` completes far too fast to trip it. The press must be a bare
//     `pointerdown` with NO move/up, so the hold timer resolves.
//   • `expandFolder` — since MYND-561 the folder tree starts fully COLLAPSED
//     (desktop parity: the expand set is restored from `vault.workspace`, and a
//     fresh mock vault has none), so any assertion about a nested row must open
//     its parent chain first.
//   • `closeSheet` — the Settings sheet has no close button and no Escape
//     binding, so dismissal is a backdrop tap at a coordinate.
//   • `rootCustomProps` — the CSSOM applier's effect is only observable through
//     the style attribute's own key list, not a computed value.
//
// Each was copy-pasted into two or three specs before landing here; they live in
// this module so the next spec inherits them instead of making a fourth copy.

import { expect, type Page } from "@playwright/test";

/** Locate a folder row by its display name (`data-folder-path` carries the last
 *  segment, not the full path). */
export function folderRow(page: Page, name: string) {
  return page.locator(`[data-testid="notes.folder-row"][data-folder-path="${name}"]`);
}

/**
 * Open a folder's subtree so its nested rows render, and wait until the row
 * actually reports itself expanded — the disclosure is animated, so asserting on
 * a child immediately after the click races the render.
 */
export async function expandFolder(page: Page, name: string): Promise<void> {
  const row = folderRow(page, name);
  await row.click();
  await expect(row).toHaveAttribute("data-collapsed", "false");
}

/**
 * Fire a long-press on the first element matching `selector`: a bubbling
 * `pointerdown`, a wait past the 480ms hold threshold with no pointer move, then
 * the `pointerup` a real finger supplies. The release is what opens the action
 * sheet now that the rows are drag sources.
 */
export async function longPress(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) throw new Error(`longPress: no element for ${sel}`);
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: r.x + 8, clientY: r.y + 8 }),
    );
  }, selector);
  await page.waitForTimeout(600);
  // The release, because a hold is not over until the finger lifts: since the
  // rows became drag sources (`useHold`'s drag phase) the sheet opens on
  // pointerup rather than at the timer, so a helper that never lifts asserts a
  // gesture no device can perform.
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) throw new Error(`longPress: no element for ${sel}`);
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, cancelable: true, clientX: r.x + 8, clientY: r.y + 8 }),
    );
  }, selector);
}

/**
 * Dismiss the Settings sheet by tapping the backdrop above the card — the
 * Sheet's only programmatic exit (it has no close button; the alternatives are a
 * backdrop tap and a grabber drag). Escape is NOT bound.
 *
 * Reopening remounts the sheet, which drops any optimistic draft, so what the
 * reopened panel shows is DISK truth rather than the write that produced it.
 */
export async function closeSheet(page: Page): Promise<void> {
  await page.mouse.click(195, 50);
  await expect(page.getByTestId("sheet.card")).toHaveCount(0);
}

/**
 * Every `--*` custom property currently set on `<html>` by the CSSOM, as a
 * `key → value` map. Reading the style attribute's own key list (rather than a
 * computed value) is what distinguishes "the applier wrote it" from "a stylesheet
 * happened to define it", which is the whole point of the revert assertions.
 */
export function rootCustomProps(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const s = document.documentElement.style;
    const out: Record<string, string> = {};
    for (let i = 0; i < s.length; i++) {
      const key = s.item(i);
      if (key.startsWith("--")) out[key] = s.getPropertyValue(key);
    }
    return out;
  });
}

/**
 * The custom-theme fixture both MYND-598 specs seed `customThemes` with. Given
 * in the host's UTF-8 byte order (uppercase first) so a locale-collation
 * assertion over it is meaningful rather than incidental, and "Zinc" is a dark
 * palette defining none of the 12 syntax roles — which is what makes the shared
 * syntax-token derivation observable in the applied properties.
 */
export const SEEDED_THEMES = [
  {
    name: "Zinc",
    palette: {
      "--paper": "#101014",
      "--paper-2": "#191920",
      "--ink-1": "#e6e6ea",
      "--accent": "#7aa2f7",
      "--line-1": "#2a2a33",
    },
  },
  {
    name: "amber dusk",
    palette: {
      "--paper": "#fdf6e3",
      "--paper-2": "#f5ecd7",
      "--ink-1": "#3b3228",
      "--accent": "#b58900",
      "--line-1": "#e0d5bb",
    },
  },
];

/** Every `custom_theme` value written through `plugin:prefs|set_custom_theme`
 *  (recorded by the mock IPC layer). */
export function customThemeWrites(page: Page): Promise<(string | null)[]> {
  return page.evaluate(
    () => (window as unknown as { __customThemeWrites?: (string | null)[] }).__customThemeWrites ?? [],
  );
}

/** Every `icon` value written through `plugin:prefs|vault_set_icon` (vault-icons,
 *  recorded by the mock IPC layer). `null` entries are the clear-to-wordmark
 *  writes. Asserting on this is what proves the real command fired rather than
 *  the mock's unknown-command catch-all. */
export function vaultIconWrites(page: Page): Promise<(string | null)[]> {
  return page.evaluate(
    () => (window as unknown as { __vaultIconWrites?: (string | null)[] }).__vaultIconWrites ?? [],
  );
}

/** Every `plaintext` body written through `plugin:notes|note_update`. The
 *  soft-delete mutations go through this command rather than `note_delete`, so a
 *  trash or archive is proven by the frontmatter stamp in the payload here, not
 *  by an absence somewhere else. */
export function noteUpdates(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __noteUpdates?: string[] }).__noteUpdates ?? [],
  );
}

/** Every note id passed to `plugin:notes|note_delete`, the HARD delete. Usually
 *  asserted empty: it is what separates a soft-trash from a destruction. */
export function noteDeletes(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __noteDeletes?: string[] }).__noteDeletes ?? [],
  );
}

/**
 * The word every cell of a mock-generated identity phrase carries
 * (myne-md/myne#911 task 12).
 *
 * The identity ceremony ends with a FOUR-WORD type-back at random positions, and
 * the positions are not predictable from the spec. A phrase of 24 identical words
 * makes every position satisfiable by typing this one, which is the same device
 * the create-vault spec has always used for the vault kit's type-back.
 */
export const IDENTITY_WORD = "ribbon";

/** The `sync_person_setup` result a spec needs to drive the identity ceremony:
 *  one generated phrase, 24 copies of {@link IDENTITY_WORD}. */
export const IDENTITY_SETUP_RESULT = {
  phrase: Array.from({ length: 24 }, () => IDENTITY_WORD).join(" "),
  fingerprint_hex: "ab".repeat(32),
  person_id_hex: "cd".repeat(16),
  identity_code: "MYNE-PERSON-1:" + "cd".repeat(16),
  approved: false,
};

/**
 * Fill a `layout="field"` phrase entry (myne-md/myne#945 item 02) with the whole
 * phrase in one go.
 *
 * The two identity-entry steps take the phrase as ONE textarea rather than 24
 * cells, because the phrase arrives as a string from another device or a password
 * manager. So a spec fills one element, and the `-cell-N` testids the grid mints
 * are gone from those steps. Selecting `input[...]` to assert the field's absence
 * finds nothing whether it is there or not (the element is a `textarea`), so an
 * absence assertion must key on the testid alone.
 *
 * `testId` is the field's own testid, which is what the caller passed as
 * `cellTestId(0)` (`identity-flow.register-cell`, `identity-flow.person-join-cell`).
 */
export async function fillPhraseField(
  page: Page,
  testId: string,
  word: string = IDENTITY_WORD,
): Promise<void> {
  await page.getByTestId(testId).fill(Array.from({ length: 24 }, () => word).join(" "));
}

/**
 * Welcome → the identity ceremony → the identity home
 * (myne-md/myne#911 task 12).
 *
 * The phone's first run is ONE door now, and the vault follows from the identity
 * home rather than sitting beside it on the welcome screen: this helper walks the
 * ceremony so a spec about VAULTS does not have to restate it. It ends on the home
 * step with the create-vault action visible, which is where a vault spec continues.
 *
 * Caller owes `installMockIpc(page, { personSetupResult: IDENTITY_SETUP_RESULT })`.
 */
export async function createIdentityToHome(page: Page): Promise<void> {
  // One click, one landing: the first-run create door opens the create step
  // directly, because this screen already carries both of the choices a gate in
  // front of it used to re-ask.
  await page.getByTestId("welcome.create-cta").click();
  await page.getByTestId("identity-flow.create").click();

  // Step 1: the phrase, which must be REVEALED before Continue enables.
  await page.getByTestId("identity-flow.phrase-reveal").click();
  await page.getByTestId("identity-flow.phrase-continue").click();

  // Step 2: the four-word type-back. Each cell is an input carrying a
  // `identity-flow.typeback-<position>` testid; the positions are random, so the
  // identical-word phrase is what makes this fillable.
  const cells = page.locator('input[data-testid^="identity-flow.typeback-"]');
  const count = await cells.count();
  expect(count).toBe(4);
  for (let i = 0; i < count; i += 1) {
    await cells.nth(i).fill(IDENTITY_WORD);
  }
  await page.getByTestId("identity-flow.typeback-continue").click();

  // The identity home, whose create-vault action is the exit into vault creation.
  await expect(page.getByTestId("identity-flow.home-create-vault")).toBeVisible();
}

/** The identity home's create-vault action: the second half of the one-door first
 *  run. Separate from {@link createIdentityToHome} because a spec may want to
 *  assert something about the home before leaving it. */
export async function startVaultFromIdentityHome(page: Page): Promise<void> {
  await page.getByTestId("identity-flow.home-create-vault").click();
}
