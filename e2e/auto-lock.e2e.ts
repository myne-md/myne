// Idle auto-lock timed-chain suite (MYND-229, SYNC-15).
//
// Pins the REAL idle-lock chain end-to-end through the production bundle:
// an unlocked editor, left untouched past its auto-lock timeout, is
// zeroized by the backend idle timer — which hides the window, drops the
// keys, and reloads the WebView — after which the app boots straight back
// to the SAME vault's unlock screen. The feature itself shipped under
// MYND-121 (idle-on-lock) + MYND-207 (multi-vault); this suite moves the
// timed chain off "Rust-unit + manual smoke" onto the tauri-driver harness.
//
// "Same vault" oracle: the boot probe, finding the sole vault with the
// slot now Empty, routes to `unlock` WITH a `vaultId` (`stage.ts`
// `initialStageFromProbe` single-vault arm), which `Unlock.tsx` mirrors as
// `unlock.form[data-vault-id=…]` (SYNC-8). Matching that exact id is the
// proof the chain returned to the vault that locked — not a generic screen.
//
// Timeout is set through the REAL Settings → Privacy select (its smallest
// option, "1 min" / 60s); the backend's `set_auto_lock_timeout` updates the
// cached timer LIVE, so no re-unlock is needed to arm it. Wall-clock is
// ~65s (60s idle + 5s poll + 1.5s flush grace); well inside the 180s
// per-scenario budget. The wait polls for the unlock screen WITHOUT driving
// any input: the activity heartbeat keys only on real DOM
// mousemove/keydown/focus/visibilitychange, so WebDriver's `findElement`
// polling never resets the idle timer (fail-closed).
//
// Deliberately NOT covered here (downgraded — see SYNC-15 ledger entry):
//   - activity-resets-the-timer: inherently timing-flaky in E2E; the timer
//     arithmetic is pinned by `auto_lock.rs` Rust units.
//   - multi-vault idle-lock: a ≥2-vault boot routes to the PICKER (the
//     active-vault identity is gone once the slot is Empty) — a different
//     story than "same vault", covered by the multi-vault Rust units.
//
// KDF: weak generator fixture (SYNC-9 — unlock reads params from vault.meta).

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { dismissImporterOffer, openSettings, closeSettings, unlockToEditor } from "./support/flows";
import { testIdSelector } from "./support/webdriver";

describeE2E("al1 idle auto-lock returns to the same vault (MYND-229)", () => {
  // Precondition: exactly 1 vault (weak KDF).
  it("an idle timeout locks the vault and boots back to its own unlock screen", async () => {
    let vaultId = "";
    let password = "";
    await scenario(
      "al1-idle-lock-same-vault",
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

        // Privacy → Auto-lock 1 min (60s) — the smallest offered option,
        // so the chain fires as soon as the harness can plausibly wait it
        // out. The write lands on disk and updates the cached timer live;
        // a single read confirms the native <select> registered the click.
        await openSettings(s, "privacy");
        await (
          await s.waitForElement('[data-testid="settings.auto-lock-select"] option[value="60"]')
        ).click();
        if ((await (await s.byTestId("settings.auto-lock-select")).property<string>("value")) !== "60") {
          throw new Error("auto-lock select did not register the 1-min option");
        }
        await closeSettings(s);

        // Sit idle. NO input from here on — any sendKeys/click would beat
        // the heartbeat and reset the timer. Polling for the unlock input
        // (a WebDriver find, not a DOM event) is inert. Its appearance is
        // the whole chain: idle fired → keys zeroized → window hidden →
        // WebView reloaded → fresh boot landed on `unlock`. 90s budget
        // covers the 60s timeout + the 5s poll tick + the 1.5s flush grace.
        await s.byTestId("unlock.password-input", { timeoutMs: 90_000 });

        // Same-vault oracle: the unlock form carries the id of the vault
        // that just locked (single-vault boot arm threads `vaultId`). A
        // generic / picker landing would carry no such match.
        await s.waitForElement(testIdSelector("unlock.form", { "data-vault-id": vaultId }));

        // And the same password re-opens that vault into the editor.
        await unlockToEditor(s, password);
      },
    );
  });
});
