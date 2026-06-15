// Vault prefs persistence suite (MYND-225, e2e-expansion wave 2).
//
// Pins the `vault.prefs` (MYP1) round-trip through the REAL Settings UI:
// a pref set via its production control survives a WebView reload (the
// Cmd+R primitive — host slot stays Unlocked, prefs re-read from disk on
// editor re-entry), and prefs are PER-VAULT (vault A's choices never
// bleed into vault B). The vault label additionally exercises the RAM
// label cache: evicted on lock, refilled on unlock (MYND-205 § 9.5.6).
//
// Theme oracle: `<html data-theme>` — the single DOM projection of the
// stored theme (`src/lib/theme.ts`). Present ⟺ vault unlocked AND an
// explicit (non-system) pref; every locked/boot stage removes it (the
// UI-layer image of zeroize-on-lock, asserted in passing in pf3).
//
// KDF: weak generator fixtures throughout (SYNC-9 — params are
// vault.meta-resident; no production-KDF story here).

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, seedVaults } from "./support/fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  openSettings,
  selectPickerRow,
  switchToVault,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Current `<html data-theme>` value (null when the attribute is absent
 *  — the system/locked baseline). Fresh lookup per call: the `<html>`
 *  handle goes stale across `refresh()`. */
async function themeAttr(session: Session): Promise<string | null> {
  return (await session.findElement("html")).attribute("data-theme");
}

async function expectThemeAttr(session: Session, expected: string | null): Promise<void> {
  await session.waitUntil(async () => (await themeAttr(session)) === expected || null, {
    label: `html[data-theme] === ${String(expected)}`,
  });
}

/**
 * Assert the switcher's row for `vaultId` does (or does not) carry
 * `label` in its name. The switcher fires ONE fresh `vault_list` probe
 * per dropdown open (and CANCELS it if the menu closes first — the
 * `[open]` effect's cleanup), so the menu must STAY OPEN while we poll:
 * the rows re-render in place when the probe lands.
 */
async function expectSwitcherRowLabel(
  session: Session,
  vaultId: string,
  label: string,
  includes = true,
): Promise<void> {
  const chip = await session.byTestId("switcher.chip");
  await chip.click(); // open → fires the fresh listVaults probe
  const rowSelector = testIdSelector("switcher.vault-row", { "data-vault-id": vaultId });
  await session.waitForElement(rowSelector);
  // `textContent()`, not W3C getText: the name lives in a nested <span>
  // this driver's getText drops. Re-found per poll — the row re-renders
  // when the fresh probe lands.
  const rowText = async () => (await session.findElement(rowSelector)).textContent();
  if (includes) {
    await session.waitUntil(async () => (await rowText()).includes(label) || null, {
      label: "switcher row shows label",
      timeoutMs: 10_000,
    });
  } else {
    // Absence needs no settling wait: neither the stale mount projection
    // nor the fresh probe ever carried this label for the vault.
    if ((await rowText()).includes(label)) {
      throw new Error("switcher row unexpectedly carries the other vault's label");
    }
  }
  await chip.click(); // close (toggle)
  await session.waitForGone(testIdSelector("switcher.vault-row"));
}

describeE2E("pf1 theme + auto-lock round-trip (MYND-225)", () => {
  // Precondition: exactly 1 vault (weak KDF).
  it("a theme and auto-lock choice set via Settings survive a reload", async () => {
    let password = "";
    await scenario(
      "pf1-theme-autolock-roundtrip",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Appearance → Dark. Disk-first write, then `applyTheme` flips
        // the attribute — both observable immediately.
        await openSettings(s, "appearance");
        await (await s.byTestId("settings.theme-dark")).click();
        await expectThemeAttr(s, "dark");

        // Privacy → Auto-lock 15 min (default is 300; a non-default
        // value is what proves the read-back). The control is now a searchable
        // dropdown: open the trigger, click the 900s option, then confirm the
        // trigger summarises the choice by its label.
        await (await s.byTestId("settings.tab-privacy")).click();
        await (await s.byTestId("settings.auto-lock-select")).click();
        await (
          await s.waitForElement(
            '[data-testid="settings.auto-lock-select-option"][data-value="900"]',
          )
        ).click();
        if (
          !(await (await s.byTestId("settings.auto-lock-select")).textContent()).includes("15 min")
        ) {
          throw new Error("auto-lock select did not register the option click");
        }
        await closeSettings(s);

        // Reload. Slot stays Unlocked → boots straight back into the
        // editor; prefs re-read from the MYP1 blob on entry.
        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
        await expectThemeAttr(s, "dark");

        // The controls themselves read back the persisted values. Both
        // panels load their stored value in a mount effect — poll, don't
        // snapshot the pre-effect default.
        await openSettings(s, "appearance");
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.theme-dark")).attribute("aria-checked")) ===
              "true" || null,
          { label: "theme segment reads back dark" },
        );
        await (await s.byTestId("settings.tab-privacy")).click();
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.auto-lock-select")).textContent()).includes(
              "15 min",
            ) || null,
          { label: "auto-lock select reads back 15 min (900s)" },
        );
      },
    );
  });
});

describeE2E("pf4 sidebar note-timestamp visibility round-trip (sidebar-note-timestamps)", () => {
  // Precondition: exactly 1 vault (weak KDF).
  it("hiding the sidebar timestamp via Settings drops the subtitle and survives a reload", async () => {
    let password = "";
    await scenario(
      "pf4-note-timestamps-roundtrip",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // A note row is the carrier of the per-note timestamp subtitle.
        await createNote(s, "Tarih Notu");
        // Default ON → the subtitle line is present under the title.
        await s.byTestId("notes.row-subtitle");

        // Appearance → toggle "Show edit times" OFF. The setter bumps the prefs
        // nonce so the sidebar (its own usePrefs instance) re-reads live.
        await openSettings(s, "appearance");
        const toggle = await s.byTestId("settings.note-timestamps-toggle");
        if ((await toggle.attribute("aria-checked")) !== "true") {
          throw new Error("note-timestamps toggle did not start ON (default true)");
        }
        await toggle.click();
        await s.waitUntil(
          async () => (await toggle.attribute("aria-checked")) === "false" || null,
          { label: "note-timestamps toggle flips OFF" },
        );
        await closeSettings(s);

        // The row stays, but its subtitle is gone — the note didn't vanish.
        await s.byTestId("notes.row");
        await s.waitForGone(testIdSelector("notes.row-subtitle"));

        // Reload. Slot stays Unlocked → straight back to the editor; prefs
        // re-read from the MYP1 blob, so the subtitle stays hidden (persisted).
        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
        await dismissImporterOffer(s);
        await s.byTestId("notes.row");
        await s.waitForGone(testIdSelector("notes.row-subtitle"));

        // The toggle itself reads back OFF from disk (mount effect — poll).
        await openSettings(s, "appearance");
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.note-timestamps-toggle")).attribute(
              "aria-checked",
            )) === "false" || null,
          { label: "note-timestamps toggle reads back OFF" },
        );
      },
    );
  });
});

describeE2E("pf2 vault label + RAM cache round-trip (MYND-225)", () => {
  // Precondition: exactly 1 vault (weak KDF).
  it("a saved label shows on the switcher row and survives lock → unlock", async () => {
    let vaultId = "";
    let password = "";
    await scenario(
      "pf2-label-cache",
      {
        seed: (dir) => {
          const v = seedVault(dir);
          vaultId = v.vaultId;
          password = v.password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Account panel (the modal's default tab) → label → Save.
        await openSettings(s);
        const input = await s.byTestId("settings.label-input");
        await input.replaceText("Kasa-Bir");
        const save = await s.byTestId("settings.label-save");
        await save.click();
        // Save success re-disables the button (draft === saved).
        await s.waitUntil(async () => !(await save.enabled()) || null, {
          label: "label save re-disabled (persisted)",
        });
        await closeSettings(s);

        // The switcher projects the cached label (dropdown open is the
        // production refresh point).
        await expectSwitcherRowLabel(s, vaultId, "Kasa-Bir");

        // Lock evicts the cache; unlock re-reads prefs and refills it.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);
        await expectSwitcherRowLabel(s, vaultId, "Kasa-Bir");
      },
    );
  });
});

describeE2E("pf3 per-vault isolation (MYND-225)", () => {
  // Precondition: exactly 2 vaults (weak KDF).
  it("vault A's theme and label never bleed into vault B", async () => {
    let a!: { vaultId: string; password: string };
    let b!: { vaultId: string; password: string };
    await scenario(
      "pf3-multi-vault-isolation",
      {
        seed: (dir) => {
          const [va, vb] = seedVaults(dir, { count: 2 });
          a = va;
          b = vb;
        },
      },
      async (app) => {
        const s = app.session;

        // ≥2 vaults boot to the picker; open A and personalize it.
        await selectPickerRow(s, a.vaultId);
        await unlockToEditor(s, a.password);
        await dismissImporterOffer(s);
        await openSettings(s);
        await (await s.byTestId("settings.label-input")).replaceText("Kasa-Bir");
        const save = await s.byTestId("settings.label-save");
        await save.click();
        await s.waitUntil(async () => !(await save.enabled()) || null, {
          label: "A label persisted",
        });
        await (await s.byTestId("settings.tab-appearance")).click();
        await (await s.byTestId("settings.theme-dark")).click();
        await expectThemeAttr(s, "dark");
        await closeSettings(s);

        // Switch to B. The unlock interstitial is a locked stage — the
        // explicit theme must already be scrubbed (zeroize-on-lock image).
        await switchToVault(s, b.vaultId);
        await s.byTestId("unlock.password-input");
        await expectThemeAttr(s, null);
        await unlockToEditor(s, b.password);

        // B carries NONE of A's prefs: system theme, and B's own row
        // shows the fallback name, not A's label.
        await expectThemeAttr(s, null);
        await expectSwitcherRowLabel(s, b.vaultId, "Kasa-Bir", false);

        // And switching back, A's personalization is intact.
        await switchToVault(s, a.vaultId);
        await unlockToEditor(s, a.password);
        await expectThemeAttr(s, "dark");
        await expectSwitcherRowLabel(s, a.vaultId, "Kasa-Bir");
      },
    );
  });
});

describeE2E("pf5 editor typography round-trip (editor-typography)", () => {
  // Precondition: exactly 1 vault (weak KDF).
  it("typography presets set via Settings apply to the editor live and survive a reload", async () => {
    let password = "";
    await scenario(
      "pf5-editor-typography-roundtrip",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // An open note is the carrier of the editor content frame (the wrapper
        // that receives the typography CSS vars + content max-width).
        await createNote(s, "Tipografi Notu");
        await s.byTestId("editor.content-frame");

        // Pick a NON-default preset on each control (a default would clear to
        // null and not prove the read-back). Segments carry
        // `${testId}-${value}` (Segmented primitive).
        await openSettings(s, "editor");
        await (await s.byTestId("settings.editor-text-size-lg")).click();
        await (await s.byTestId("settings.editor-line-spacing-relaxed")).click();
        await (await s.byTestId("settings.editor-content-width-wide")).click();
        await (await s.byTestId("settings.editor-font-family-sans")).click();
        await closeSettings(s);

        // Live application: each setter bumps the prefs nonce → the editor's own
        // usePrefs re-reads and restyles the content frame (no remount). Assert
        // the inline style carries every chosen preset's CSS value.
        const frameStyle = async (): Promise<string> =>
          (await (await s.byTestId("editor.content-frame")).attribute("style")) ?? "";
        await s.waitUntil(
          async () => {
            const css = await frameStyle();
            return (
              (css.includes("16px") &&
                css.includes("1.95") &&
                css.includes("820px") &&
                css.includes("var(--font-sans)")) ||
              null
            );
          },
          { label: "editor content frame applies the typography presets live" },
        );

        // Reload. Slot stays Unlocked → boots straight back into the editor;
        // prefs re-read from the MYP1 blob on entry.
        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });

        // The controls themselves read back the persisted presets (mount effect
        // loads the stored value — poll, don't snapshot the pre-effect default).
        await openSettings(s, "editor");
        const readsBack = async (testId: string): Promise<boolean | null> =>
          (await (await s.byTestId(testId)).attribute("aria-checked")) === "true" || null;
        await s.waitUntil(() => readsBack("settings.editor-text-size-lg"), {
          label: "text-size reads back lg",
        });
        await s.waitUntil(() => readsBack("settings.editor-line-spacing-relaxed"), {
          label: "line-spacing reads back relaxed",
        });
        await s.waitUntil(() => readsBack("settings.editor-content-width-wide"), {
          label: "content-width reads back wide",
        });
        await s.waitUntil(() => readsBack("settings.editor-font-family-sans"), {
          label: "font-family reads back sans",
        });
      },
    );
  });
});
