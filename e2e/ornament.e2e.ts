// Ornament suite (deep-customization, myne#394). Pins the four properties the
// design decisions promised, against the real IPC + the real WebView:
//
//   or1 — a theme carrying ornament selections reflects them onto `:root` as
//         `data-o-<role>-<primitive>` attributes, and a role-bearing element is
//         present for the stylesheet to select. This is the bridge the whole
//         feature rests on: CSS cannot branch on a custom property's VALUE, so
//         if the reflection stops happening every ornament silently disappears
//         and nothing else notices.
//   or2 — locking the vault clears BOTH the palette variables and the ornament
//         attributes. The A6 property: a locked screen must reveal nothing
//         about its owner, and an ornament attribute is as telling as a colour.
//   or3 — a palette below the WCAG floor is REFUSED at import, naming the pair.
//         The gate is `theme-validator`'s and runs on the real command path.
//   or4 — a theme naming an ornament variant this build does not know still
//         imports and still paints its colours; the unknown primitive simply
//         renders plain. That is the forward-compatibility contract older
//         clients depend on.
//
// Why page-seat IPC to seed: same reason as `custom-themes.e2e.ts` — the native
// import dialog is undriveable by WebDriver, so the theme is sealed by firing
// the production `themes_import` command from the page seat. Real IPC, zero
// test hooks.
//
// STILL OWED (myne#394 task 14): the hit-rectangle measurement — a control's
// clickable geometry with and without ornament must be identical. It belongs
// here rather than in Vitest because jsdom has no layout engine, and it is the
// assertion that turns the paint-layer rule from an intention into a guarantee.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  dismissImporterOffer,
  openSettings,
  pageSeatInvoke,
  unlockToEditor,
  rootInlineStyle,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A complete, readable palette — the base every fixture below extends. */
const BASE: Record<string, string> = JSON.parse(
  readFileSync(join(HERE, "fixtures", "themes", "catppuccin-mocha.json"), "utf8"),
);

/** The same palette, wearing ornament on all three roles. */
const ORNAMENTED = JSON.stringify({
  ...BASE,
  "--box-frame": "thick",
  "--box-shadow": "offset",
  "--surface-texture": "scanline",
  "--chrome-frame": "hairline",
});

/** A palette whose primary ink is indistinguishable from its paper. */
const UNREADABLE = JSON.stringify({ ...BASE, "--ink-1": BASE["--paper"] });

/** A palette naming a frame variant no build has ever shipped. */
const UNKNOWN_VARIANT = JSON.stringify({ ...BASE, "--box-frame": "quadruple" });

/** The `<html>` element's attribute value, or `null` when absent. */
async function rootAttr(session: Session, name: string): Promise<string | null> {
  return (await (await session.findElement("html")).attribute(name).catch(() => null)) ?? null;
}

/** Seal a palette into the unlocked vault through the production command. */
async function importTheme(
  session: Session,
  name: string,
  paletteJson: string,
): Promise<{ err?: unknown }> {
  return pageSeatInvoke(session, "plugin:themes|themes_import", { name, paletteJson }, 15_000);
}

/** Import + apply a theme, leaving Settings → Appearance open. */
async function applyTheme(session: Session, name: string, paletteJson: string): Promise<void> {
  const imported = await importTheme(session, name, paletteJson);
  if (imported.err !== undefined) {
    throw new Error(`themes_import failed: ${JSON.stringify(imported.err)}`);
  }
  await openSettings(session, "appearance");
  const rowSel = testIdSelector("settings.custom-theme-row", { "data-theme-name": name });
  await session.waitForElement(rowSel);
  await (await session.byTestId("settings.custom-theme-apply")).click();
  await session.waitUntil(
    async () => ((await (await session.findElement(rowSel)).attribute("data-active")) === "true" ? true : null),
    { label: `custom-theme ${name} active` },
  );
}

describeE2E("or1 ornament selections reach the DOM (myne#394)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("reflects each selection as a root attribute, and a role-bearing element exists", async () => {
    let password = "";
    await scenario(
      "or1-ornament-reflection",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await applyTheme(s, "ornamented", ORNAMENTED);

        // The bridge: CSS cannot branch on a custom property's value, so every
        // recognized selection is reflected onto the root as an attribute.
        expect(await rootAttr(s, "data-o-box-frame")).toBe("thick");
        expect(await rootAttr(s, "data-o-box-shadow")).toBe("offset");
        expect(await rootAttr(s, "data-o-surface-texture")).toBe("scanline");
        expect(await rootAttr(s, "data-o-chrome-frame")).toBe("hairline");

        // …and something in the tree actually carries a role for those rules to
        // select. The bottom bar is chrome and is always present in the editor.
        const chrome = await s.findElement('[data-ornament="chrome"]');
        expect(chrome).toBeTruthy();
      },
    );
  });
});

describeE2E("or2 locking clears ornament, not just colour (myne#394, A6)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("removes both the palette vars and the ornament attributes on lock", async () => {
    let password = "";
    await scenario(
      "or2-ornament-cleared-on-lock",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await applyTheme(s, "ornamented", ORNAMENTED);
        expect(await rootAttr(s, "data-o-box-frame")).toBe("thick");

        // `applyTheme` leaves Settings open, and the modal covers the bottom
        // bar — the Lock control is unreachable until it closes.
        await closeSettings(s);

        // Lock from the bottom bar's Lock control — the production path, the
        // same testid `lockAndReunlock` drives.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");

        // A locked screen must reveal nothing about its owner. An ornament
        // attribute is as telling as a colour, so both come off.
        expect(await rootAttr(s, "data-o-box-frame")).toBeNull();
        expect(await rootAttr(s, "data-o-surface-texture")).toBeNull();
        const style = await rootInlineStyle(s);
        expect(style).not.toContain("--paper");
      },
    );
  });
});

describeE2E("or3 an unreadable palette is refused (myne#394)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("rejects at import and names the failing pair", async () => {
    let password = "";
    await scenario(
      "or3-unreadable-refused",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        const result = await importTheme(s, "unreadable", UNREADABLE);
        expect(result.err, "an unreadable palette must be refused").toBeDefined();
        // The error names WHICH pair failed and by how much — "your theme is
        // unreadable" alone is not something an author can act on.
        const serialized = JSON.stringify(result.err);
        expect(serialized).toContain("LowContrast");
        expect(serialized).toContain("--ink-1");
        expect(serialized).toContain("--paper");
      },
    );
  });
});

describeE2E("or4 an unknown ornament variant degrades to plain (myne#394)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("still imports, still paints colour, and reflects no attribute for the unknown value", async () => {
    let password = "";
    await scenario(
      "or4-unknown-variant-degrades",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await applyTheme(s, "future", UNKNOWN_VARIANT);

        // The forward-compatibility contract: a theme built for a newer client
        // must render here, minus what this build does not understand.
        expect(await rootAttr(s, "data-o-box-frame")).toBeNull();
        const style = await rootInlineStyle(s);
        expect(style).toContain("--paper");
      },
    );
  });
});
