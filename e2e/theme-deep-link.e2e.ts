// `myne://theme/install` deep-link suite (MYND-567). Drives the one-click
// theme install through the production binary:
//
//   td1 — a theme-install link that LAUNCHES the app is held while the vault is
//         locked, presents the confirm dialog once the vault is unlocked, and on
//         Apply seals the theme into `vault.themes` AND paints its palette.
//   td2 — the same link, Cancelled: the dialog closes, the vault's theme set is
//         untouched (Settings → Appearance still shows the empty state), and no
//         palette is painted.
//   td3 — a malformed link fails visibly instead of silently applying anything.
//
// ## How the link is delivered (this is the real mechanism, not a hook)
//
// On Linux the OS resolves a `myne://` click by launching the app with the URL
// as its ONLY command-line argument. The app's `setup` hook feeds its own argv
// to `deep_link().handle_cli_arguments`, which is what makes `getCurrent()`
// return the URL to the WebView at boot. So the scenarios launch the production
// binary with the URL in argv — the same bytes, the same entry point, the same
// code path a real click produces. `launchApp({ args })` threads it through
// tauri-driver's `tauri:options.args`; production code is untouched.
//
// The WARM arrival (app already open → a second process → relayed by
// `tauri-plugin-single-instance`) is deliberately NOT scripted here: that
// plugin's Linux transport is DBus and the harness image ships no session bus,
// so the scenario would prove nothing about production. Its parsing + latch half
// is covered by `tests/lib/themeDeepLink.test.ts`; the raise-the-window half is
// the single-instance plugin's own behavior, already relied on since MYND-22.
//
// Because the link is present from launch, td1 also pins the locked-vault edge
// case for free: the dialog MUST NOT appear on the unlock screen, and must
// appear after unlocking.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** A complete, valid palette — every required-core token, distinctive base. */
const PALETTE: Record<string, string> = {
  "--paper": "#0d1b2a",
  "--paper-2": "#122536",
  "--paper-3": "#17304a",
  "--ink-0": "#f2f6fb",
  "--ink-1": "#e3ebf5",
  "--ink-2": "#a8b8cc",
  "--ink-3": "#7488a0",
  "--line-1": "#1d3a4f",
  "--line-2": "#24455e",
  "--line-3": "#2c5372",
  "--accent": "#4aa3df",
  "--accent-hover": "#3d8fc6",
  "--accent-press": "#317aad",
  "--accent-soft": "#16324a",
  "--accent-on": "#06121d",
  "--danger": "#e06c75",
  "--danger-soft": "#3a1f22",
  "--warning": "#d6a45c",
  "--warning-soft": "#3a2f1c",
  "--success": "#7fb069",
  "--success-soft": "#22301c",
};

/** The `--paper` base — the oracle for "this palette actually painted". */
const PAPER = PALETTE["--paper"];

/** base64url (unpadded) of UTF-8 text — the website's payload encoding. */
function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** Build a `myne://theme/install` link the way the Themes page does. */
function installLink(overrides: Record<string, string | null> = {}): string {
  const merged: Record<string, string | null> = {
    v: "1",
    name: "Deep Harbor",
    author: "Myne",
    src: "https://myne.md/themes/",
    payload: b64url(JSON.stringify(PALETTE)),
    ...overrides,
  };
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) if (v !== null) search.set(k, v);
  return `myne://theme/install?${search.toString()}`;
}

/** The current inline `style` on `<html>` — where a custom palette lands
 *  (`setProperty` via the CSSOM, not a `data-theme` attribute). Fresh lookup
 *  per call: the handle goes stale across re-render. */
async function rootInlineStyle(session: Session): Promise<string> {
  const v = await (await session.findElement("html")).attribute("style").catch(() => null);
  return v ?? "";
}

describeE2E("td1 a launch-time theme-install link installs after unlock (MYND-567)", () => {
  // Vault-count precondition: 1 (weak KDF). No custom themes seeded.
  it("holds the link while locked, then Apply seals + paints the theme", async () => {
    let password = "";
    await scenario(
      "td1-theme-deep-link-apply",
      {
        seed: (dir) => void (password = seedVault(dir).password),
        args: [installLink()],
      },
      async (app) => {
        const s = app.session;

        // The vault is locked. The link is already in the app's hands — and the
        // confirm dialog must NOT be on the unlock screen (a locked vault is
        // never a place where vault content gets written).
        await s.byTestId("unlock.password-input");
        expect(await s.byTestIdAll("theme-install.dialog")).toHaveLength(0);

        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Unlocked → the held request surfaces, attributing what the link claims.
        await s.byTestId("theme-install.dialog");
        expect(await (await s.byTestId("theme-install.name")).text()).toBe("Deep Harbor");
        await s.byTestId("theme-install.preview");

        await (await s.byTestId("theme-install.apply")).click();

        // Apply → the palette paints onto :root via the CSSOM apply path.
        await s.waitUntil(async () => (await rootInlineStyle(s)).includes(PAPER) || null, {
          label: `:root inline style carries the deep-linked --paper base (${PAPER})`,
        });

        // …and it is really IN the vault, not just on screen: the Settings
        // picker lists it (one decrypt of vault.themes) as the active theme.
        await openSettings(s, "appearance");
        const row = await s.waitForElement(
          testIdSelector("settings.custom-theme-row", { "data-theme-name": "Deep Harbor" }),
        );
        expect(await row.attribute("data-active")).toBe("true");
      },
    );
  });
});

describeE2E("td2 cancelling a theme-install link writes nothing (MYND-567)", () => {
  // Vault-count precondition: 1 (weak KDF). No custom themes seeded.
  it("Cancel leaves the vault's theme set untouched and paints nothing", async () => {
    let password = "";
    await scenario(
      "td2-theme-deep-link-cancel",
      {
        seed: (dir) => void (password = seedVault(dir).password),
        args: [installLink()],
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await s.byTestId("theme-install.dialog");
        await (await s.byTestId("theme-install.cancel")).click();

        // The dialog goes away…
        await s.waitForGone(testIdSelector("theme-install.dialog"));
        // …nothing painted…
        expect(await rootInlineStyle(s)).not.toContain(PAPER);
        // …and nothing written: the picker still shows the no-themes state.
        await openSettings(s, "appearance");
        await s.byTestId("settings.custom-theme-empty");
      },
    );
  });
});

describeE2E("td3 a malformed theme-install link fails visibly (MYND-567)", () => {
  // Vault-count precondition: 1 (weak KDF). No custom themes seeded.
  it("reports the failure and offers no way to apply anything", async () => {
    let password = "";
    await scenario(
      "td3-theme-deep-link-malformed",
      {
        seed: (dir) => void (password = seedVault(dir).password),
        // Legal base64url that decodes to something that is not a palette —
        // the "damaged payload" case, which must never apply silently.
        args: [installLink({ payload: b64url("[not, a, palette]") })],
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await s.byTestId("theme-install.rejected");
        expect((await (await s.byTestId("theme-install.error")).text()).length).toBeGreaterThan(0);
        // No confirm affordance at all — there is nothing to confirm.
        expect(await s.byTestIdAll("theme-install.apply")).toHaveLength(0);

        await (await s.byTestId("theme-install.dismiss")).click();
        await openSettings(s, "appearance");
        await s.byTestId("settings.custom-theme-empty");
      },
    );
  });
});
