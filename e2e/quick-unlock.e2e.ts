// Quick-unlock (PIN) end-to-end suite (MYND-329).
//
// Pins the PIN quick-unlock flow through the production bundle: from an
// unlocked editor, configure a PIN in Settings → Privacy, lock the vault, and
// re-enter with the PIN (NOT the master password) — then a wrong PIN reports
// the remaining-attempts count. The biometric (Touch ID) path is deliberately
// NOT E2E-driven: it is hardware-gated (no WebDriver path) and HARDWARE-
// UNVERIFIED (see `src-tauri/.../quick_unlock/macos.rs`); its surrounding logic
// is covered by the Rust `cargo test` provider/command suites with a mock.
//
// Spring-loaded note: this scenario locks WITHIN the same app session (via the
// editor Lock CTA), so the backend's `full_unlock_this_session` gate is open
// (the earlier `unlockToEditor` opened it) and quick-unlock is permitted. The
// restart case (gate closed → RequiresFullPassword → affordance self-hides) is
// a process-restart story pinned by the Rust command units, not driven here.
//
// Precondition: exactly 1 vault (weak KDF — unlock reads params from vault.meta).
//
// ⚠️ AUTHORED, PENDING CONTAINER VERIFICATION. The data-testid pass is shipped
// and typecheck-clean (`pnpm build`); this scenario has NOT yet been run 3×
// green in the Linux tauri-driver container (`./scripts/e2e-local.sh`) — that
// is the remaining definition-of-done step (the harness is Linux-only and was
// unavailable when this landed). Run it before relying on it as a gate.

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  dismissImporterOffer,
  openSettings,
  closeSettings,
  unlockToEditor,
} from "./support/flows";

const PIN = "135790";
const WRONG_PIN = "024680";

describeE2E("qu1 PIN quick-unlock round-trip (MYND-329)", () => {
  // Precondition: exactly 1 vault (weak KDF).
  it("configures a PIN, locks, and re-enters with the PIN (wrong PIN counts down)", async () => {
    let password = "";
    await scenario(
      "qu1-pin-roundtrip",
      {
        seed: (dir) => {
          const v = seedVault(dir);
          password = v.password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // ---- Configure a PIN in Settings → Privacy --------------------------
        await openSettings(s, "privacy");
        await (await s.byTestId("settings.quick-unlock-toggle")).click();
        // Toggling on reveals the PIN setup row.
        await (await s.byTestId("settings.quick-unlock-pin-input")).replaceText(PIN);
        await (await s.byTestId("settings.quick-unlock-setup-pin")).click();
        // The status helper now reports the configured method.
        const status = await s.waitForElement('[data-testid="settings.quick-unlock-status"]');
        if (!(await status.textContent()).includes("Configured via PIN")) {
          throw new Error("quick-unlock status did not report PIN configured");
        }
        await closeSettings(s);

        // ---- Lock the vault (same session → spring-loaded gate open) --------
        await (await s.byTestId("editor.lock-cta")).click();
        // The Unlock screen shows the quick-unlock PIN affordance.
        await s.byTestId("unlock.quick-pin-input");

        // ---- Wrong PIN first: the remaining-attempts note appears ----------
        await (await s.byTestId("unlock.quick-pin-input")).replaceText(WRONG_PIN);
        await (await s.byTestId("unlock.quick-pin-submit")).click();
        const note = await s.waitForElement('[data-testid="unlock.quick-note"]');
        if (!(await note.textContent()).toLowerCase().includes("attempt")) {
          throw new Error("wrong PIN did not surface the remaining-attempts note");
        }

        // ---- Correct PIN: back to the editor (Lock CTA present again) -------
        await (await s.byTestId("unlock.quick-pin-input")).replaceText(PIN);
        await (await s.byTestId("unlock.quick-pin-submit")).click();
        await s.byTestId("editor.lock-cta", { timeoutMs: 15_000 });
      },
    );
  });
});
