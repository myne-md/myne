// rtl1 — RTL layout follows the active locale (#175). Vault-count precondition: 1.
//
// Pins the epic's foundational contract against the production binary: picking a
// right-to-left UI locale flips the document's writing direction, which is what
// drives the whole shared `src/` UI to mirror (CSS logical properties +
// `[dir="rtl"]` rules).
//   - default (English): `<html dir="ltr" lang="en">`;
//   - pick Arabic from the real language picker (Settings → Appearance) → the
//     document root becomes `<html dir="rtl" lang="ar">` live, no reload;
//   - a user-authored note title renders inside a `<bdi>` so its own script
//     direction is isolated from the surrounding RTL chrome.
//
// Direction is read off the real applied `document.documentElement`, not a
// mirror. The Arabic catalog ships empty (Weblate-filled), so the UI shows the
// English fallback strings in a mirrored RTL layout — which is exactly the
// layout-direction property under test, independent of translation progress.
//
// KDF: weak generator fixtures (unlock reads params from vault.meta).
//
// ⚠️ NEW SCENARIO — authored to the harness conventions but NOT yet validated in
// the container (this dev host is macOS; the suite is Linux/tauri-driver only).
// Definition of done per e2e/CLAUDE.md is "green 3× consecutive" via
// ./scripts/e2e-buildrun.sh. Run ISOLATED — the full suite contaminates.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import { dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";
import { type Session } from "./support/webdriver";

/** `[dir, lang]` currently on `<html>`, read off the real applied attributes. */
async function rootDir(s: Session): Promise<{ dir: string; lang: string }> {
  return s.execute(
    "return { dir: document.documentElement.getAttribute('dir') || '', " +
      "lang: document.documentElement.getAttribute('lang') || '' };",
  );
}

describeE2E("rtl1 RTL layout follows the active locale (#175)", () => {
  it("flips <html dir> to rtl when an RTL locale is picked", async () => {
    let seeded: SeededVault;
    await scenario(
      "rtl1-layout-direction",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // Default fixture locale is English → the document is LTR.
        await s.waitUntil(async () => ((await rootDir(s)).dir === "ltr" ? true : null), {
          label: "document starts LTR",
          timeoutMs: 10_000,
        });

        // Pick Arabic from the real Settings → Appearance language picker.
        await openSettings(s, "appearance");
        await (await s.byTestId("settings.language-select")).click();
        await s.byTestId("settings.language-select-menu", { timeoutMs: 10_000 });
        const options = await s.byTestIdAll("settings.language-select-option");
        let arabic = null;
        for (const o of options) {
          // Endonym labels are not translated; the Arabic entry reads "العربية".
          if ((await o.textContent()).includes("العربية")) {
            arabic = o;
            break;
          }
        }
        expect(arabic, "the picker offers Arabic (an RTL locale, myne#176)").not.toBeNull();
        await arabic!.click();

        // The document root flips live — this attribute is what mirrors the UI.
        await s.waitUntil(
          async () => {
            const { dir, lang } = await rootDir(s);
            return dir === "rtl" && lang === "ar" ? true : null;
          },
          { label: "<html> becomes dir=rtl lang=ar", timeoutMs: 10_000 },
        );

        // User-authored note titles are `<bdi>`-isolated so a mixed-script title
        // does not reorder the surrounding RTL chrome (the fixture seeds notes).
        const titleBidi = await s.byTestIdAll("notes.row");
        expect(titleBidi.length, "the seeded vault shows note rows").toBeGreaterThan(0);
        const hasBdi = await s.execute<boolean>(
          "return !!document.querySelector('[data-testid=\"notes.row\"] bdi');",
        );
        expect(hasBdi, "note titles render inside <bdi> for bidi isolation").toBe(true);
      },
    );
  });
});
