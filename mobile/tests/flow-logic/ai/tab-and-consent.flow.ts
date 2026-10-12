// Flow-logic: the mobile AI tab and the consent gate (myne-md/myne#456, #457).
//
// **Headless Chromium + mock IPC. NOT end-to-end**, and the distinction matters
// more here than in most specs on this tier: nothing below reaches a provider,
// and the host's own refusals are `core/src/inference/provider_gate.rs`'s
// business, asserted in Rust. What this file drives is the WebView half, which
// destination exists, and what the surface does before anything is sent.
//
// Three things are under test:
//
//   1. The tab is present with `ai_enabled` on and ABSENT with it off. On a
//      phone the bar has a hard column budget, so a fifth column is a fifth of
//      the width taken from the four that were there.
//   2. The case this whole feature exists to close. A device enrolled into a
//      vault another device configured inherits the provider, the model and the
//      KEY, because those are vault content and sync. It does not inherit the
//      approval, because `ai_provider_consent` is device-local
//      (`docs/spec/sync-protocol.md` §10.2). So this phone must still see the
//      consent screen, and must send nothing until somebody accepts it HERE.
//   3. The consent write, when it happens, names the PROVIDER rather than
//      setting a flag. An approval recorded as a boolean would carry over to a
//      provider the user never saw a screen about.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** A vault another device has already configured: provider, model and key all
 *  present, because all three sync. */
/** One note, so the default scope has something to be. */
const A_NOTE = [{ id: "n1", text: "---\ntitle: Migration\n---\n\nSome notes about it.\n" }];

const CONFIGURED_ELSEWHERE = {
  ai_enabled: true,
  ai_provider: "openrouter",
  ai_provider_model: "a/model",
  ai_provider_key: "sk-from-the-laptop",
  // And no consent, because consent does not sync. This is the whole fixture.
  ai_provider_consent: null,
};

test.describe("mobile AI tab", () => {
  test("is absent with the opt-in off, and the bar keeps its four columns", async ({ page }) => {
    await installMockIpc(page, { prefs: { ai_enabled: false } });
    await page.goto("/");

    await expect(page.getByTestId("workspace.tab-bar")).toBeVisible();
    await expect(page.getByTestId("workspace.tab-chat")).toHaveCount(0);
    // The four that were always there are untouched. An exact count rather than
    // a presence check: "AI off returns exactly today's layout" is the claim,
    // and a bar with a reserved gap would pass a presence check.
    await expect(page.getByTestId("workspace.tab-bar").locator("button")).toHaveCount(4);
  });

  test("is present with the opt-in on, and is the last column", async ({ page }) => {
    await installMockIpc(page, { prefs: { ai_enabled: true } });
    await page.goto("/");

    await expect(page.getByTestId("workspace.tab-chat")).toBeVisible();
    await expect(page.getByTestId("workspace.tab-bar").locator("button")).toHaveCount(5);
    // Last, so no existing column moves. Reordering top-level navigation is the
    // one change a user cannot be told about.
    const ids = await page
      .getByTestId("workspace.tab-bar")
      .locator("button")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(ids[4]).toBe("workspace.tab-chat");
  });
});

test.describe("the default scope is the open note, or the whole vault", () => {
  test("opens on the whole vault with no note open, so Send works", async ({ page }) => {
    // **myne-md/myne#848 reverses the rule this test used to pin.** It read
    // "The host refuses a root grant, so a client that built
    // `{ kind: "folder", value: "" }` as a whole-vault fallback would offer a
    // Send that cannot work", and that reasoning is still correct about the
    // FOLDER shape. What changed is that the host grew an explicit `vault`
    // grant, so "everything" is expressible without a folder path that
    // canonises to the root, and the default is now the whole vault minus the
    // excluded folders rather than nothing at all.
    await installMockIpc(page, { prefs: { ai_enabled: true }, notes: A_NOTE });
    await page.goto("/");
    await page.getByTestId("workspace.tab-chat").click();

    await expect(page.getByTestId("ai.scope-strip")).toBeVisible();
    await page.getByTestId("ai.composer-input").fill("do something");
    // The vault grant covers `A_NOTE`, so there is something to run against and
    // the button is live. Before the change this was disabled and the strip said
    // there was nothing to work on.
    await expect(page.getByTestId("ai.composer-send")).toBeEnabled();
  });
});

test.describe("consent does not arrive with the key", () => {
  test("a device that inherited a provider and a key still has to approve", async ({ page }) => {
    await installMockIpc(page, { prefs: CONFIGURED_ELSEWHERE, notes: A_NOTE });
    await page.goto("/");

    // **A note has to be open**, and that is still a real precondition rather
    // than test scaffolding: the default scope is the open note when there is
    // one, and the whole vault when there is not (myne-md/myne#848, it used to
    // be "nothing at all", because a root FOLDER grant is refused outright and
    // there was no other way to spell the vault). This scenario opens a note so
    // the run it refuses is the one anchored to that note.
    await page.getByTestId("notes.row").first().click();
    // Back to the list, because on a phone the editor REPLACES it and the tab
    // bar is not on screen while a note is open. `editing` survives the back,
    // which is what makes the note still the run's default scope.
    await page.getByTestId("editor.back").click();

    // The tab is there: `ai_enabled` synced too, so this phone offers the
    // destination. That is correct and is exactly what makes the rest of this
    // scenario the interesting case rather than a trivial one.
    await page.getByTestId("workspace.tab-chat").click();
    await expect(page.getByTestId("ai.chat")).toBeVisible();

    // Nothing has been sent, and nothing can be until the approval exists here.
    // Asserted through the host: the composer is willing, the gate is not.
    await page.getByTestId("ai.composer-input").fill("summarise these notes");
    await page.getByTestId("ai.composer-send").click();

    // The host refuses, and the surface says WHICH refusal. Not the catch-all:
    // "that did not work" over an inherited key is the message this feature
    // exists to stop, because it names no fix and the fix is one screen away.
    await expect(page.getByTestId("ai.turn-error")).toBeVisible();

    // And the approval genuinely is not on this device: nothing wrote one.
    const writes = await page.evaluate(
      () => (window as unknown as { __aiConsentWrites?: unknown[] }).__aiConsentWrites ?? [],
    );
    expect(writes).toEqual([]);
  });

  test("approving here records the PROVIDER, not a flag", async ({ page }) => {
    await installMockIpc(page, { prefs: CONFIGURED_ELSEWHERE });
    await page.goto("/");

    // Settings → AI. The provider reads as SELECTED, because it synced. What
    // did not sync is the approval, and the panel says so in its own row rather
    // than leaving the user to toggle a working provider off and on to find the
    // consent screen.
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByTestId("settings.category-ai").click();
    await expect(page.getByTestId("settings.ai-approve-here")).toBeVisible();
    await page.getByTestId("settings.ai-approve-here").click();

    const consent = page.getByTestId("ai-consent.screen");
    await expect(consent).toBeVisible();
    // The whole disclosure is on the accepting screen, not a summary with the
    // detail one tap away. The clause a consent screen usually omits is the one
    // asserted here.
    await expect(page.getByTestId("ai-consent.cannot-verify")).toBeVisible();
    await expect(page.getByTestId("ai-consent.scope")).toBeVisible();

    await page.getByTestId("ai-consent.accept").click();

    // Recorded per provider. An approval stored as a boolean would carry over
    // to a provider the user never saw a screen about, which is why the host
    // compares by equality rather than truthiness.
    // Polled rather than read once: the provider write is AWAITED before the
    // consent one is dispatched, so nothing is recorded at the instant of the
    // click. The mock's provider handler is deliberately slow, which is what
    // makes the ordering assertion below able to fail.
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __aiConsentWrites?: unknown[] }).__aiConsentWrites ?? [],
        ),
      )
      .toEqual(["openrouter"]);

    // **And the PROVIDER write landed first.** `set_ai_provider` clears the
    // consent whenever the selection changes, which on a first approval it
    // always has, so a consent that arrives first is erased by the very next
    // call. The handler declared that order load-bearing in a comment while
    // `writeDraftPref` fired and forgot, so both commands raced to the prefs
    // mutex and the written order decided nothing. The failure is not visible
    // here either: the optimistic draft keeps rendering the consent as granted
    // until the sheet is closed and reopened, and only then does the device look
    // configured while refusing every request as ConsentMissing.
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __aiPrefWrites?: string[] }).__aiPrefWrites ?? [],
        ),
      )
      .toEqual(["provider", "consent"]);

    // The state the order exists to produce, asserted rather than inferred from
    // it: the consent survived the provider write.
    const consentWrites = await page.evaluate(
      () => (window as unknown as { __aiConsentWrites?: (string | null)[] }).__aiConsentWrites ?? [],
    );
    expect(consentWrites.at(-1)).toBe("openrouter");
  });

  test("dismissing the consent screen stores nothing", async ({ page }) => {
    // The load-bearing half of "dismissing is declining": there is no dismissal
    // that leaves a consent recorded, so there is none that has to be undone.
    await installMockIpc(page, { prefs: CONFIGURED_ELSEWHERE });
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByTestId("settings.category-ai").click();
    await page.getByTestId("settings.ai-approve-here").click();

    await expect(page.getByTestId("ai-consent.screen")).toBeVisible();
    await page.getByTestId("ai-consent.cancel").click();

    await expect(page.getByTestId("ai-consent.screen")).toHaveCount(0);
    // And the row is still there, so declining leaves the offer rather than
    // hiding the one route back to it.
    await expect(page.getByTestId("settings.ai-approve-here")).toBeVisible();
    const writes = await page.evaluate(
      () => (window as unknown as { __aiConsentWrites?: unknown[] }).__aiConsentWrites ?? [],
    );
    expect(writes).toEqual([]);
  });
});
