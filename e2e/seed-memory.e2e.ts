// Reviewed vault seed flow suite (myne-md/myne#915).
//
// Runs against the **`local-inference-stub` build variant** (`MYNE_E2E_AI=1`),
// whose engine answers the seed's two prompts deterministically: three entries,
// one read request naming a folder it found in the outline. No model file is in
// the repo (SYNC-5).
//
//   seed1 — enable AI, grow the vault past the offer's floor, open the chat zero
//           state, take the once-only card into the wizard, pass the local scope
//           step, generate, apply, and find the entries under `From your vault`.
//   seed2 — rebuild from the Settings row and assert the count REPLACED rather
//           than doubled (the replace-only-own-rows rule).
//
// KDF: weak generator fixture (SYNC-9, params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  enableAi,
  enableDeveloperMode,
  openSettings,
  selectSettingsTopic,
  unlockToEditor,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

/** The card's floor is ten live notes (myne-md/myne#915). Titles are unique so
 *  the sidebar rows cannot collapse into one. */
async function growVault(s: Session): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await createNote(s, `seed note ${i} alpha7k2m9qx4w8e5rj0`);
  }
}

async function openMemorySection(s: Session): Promise<void> {
  await openSettings(s, "ai");
  await selectSettingsTopic(s, "ai", "advanced");
  await s.waitForElement(testIdSelector("settings.memory.seed-row"), { timeoutMs: 15_000 });
}

async function runWizardToApplied(s: Session): Promise<void> {
  await (await s.byTestId("settings.memory.seed.continue")).click();
  // The stub answers phase one immediately; the candidate list is the proof the
  // whole two-phase contract (prompt, parse, review) ran.
  await s.waitForElement(testIdSelector("settings.memory.seed.candidate-list"), {
    timeoutMs: 30_000,
  });
  expect(await s.byTestIdAll("settings.memory.seed.candidate")).toHaveLength(3);
  await (await s.byTestId("settings.memory.seed.apply")).click();
  await s.waitForElement(testIdSelector("settings.memory.seed.done"), { timeoutMs: 30_000 });
  await (await s.byTestId("settings.memory.seed.finish")).click();
}

aiDescribe("seed1 the once-only card seeds memory through the reviewed wizard", () => {
  it("offers the card, sends the tree, applies three entries and groups them", async () => {
    let password = "";
    await scenario(
      "seed1-seed-memory",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await enableDeveloperMode(s);
        await closeSettings(s);
        await enableAi(s);
        await growVault(s);

        // ── The chat zero state offers the seed ──
        await (
          await s.waitForElement(
            testIdSelector("editor.right-panel-tab", { "data-panel-tab-id": "ai-chat" }),
          )
        ).click();
        await s.byTestId("ai.seed-card", { timeoutMs: 20_000 });
        await (await s.byTestId("ai.seed-card-start")).click();

        // ── Scope: the real payload is behind the toggle, local needs no consent ──
        await s.waitForElement(testIdSelector("settings.memory.seed.scope"), {
          timeoutMs: 15_000,
        });
        await (await s.byTestId("settings.memory.seed.toggle-payload")).click();
        const payload = await s.waitForElement(testIdSelector("settings.memory.seed.payload"), {
          timeoutMs: 10_000,
        });
        expect(await payload.textContent()).toContain("VAULT OUTLINE");
        expect(await s.byTestIdAll("settings.memory.seed.consent")).toHaveLength(0);
        await runWizardToApplied(s);

        // ── The entries are grouped under From your vault ──
        await openMemorySection(s);
        const group = await s.byTestId("settings.memory.seed-group", { timeoutMs: 15_000 });
        expect(await group.textContent()).toContain("From your vault");
        expect(await s.byTestIdAll("settings.memory.seed-entry")).toHaveLength(3);
        await closeSettings(s);
      },
    );
  });
});

aiDescribe("seed2 rebuild replaces its own rows instead of doubling them", () => {
  it("keeps three seed entries after a second reviewed pass", async () => {
    let password = "";
    await scenario(
      "seed2-seed-rebuild",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await enableDeveloperMode(s);
        await closeSettings(s);
        await enableAi(s);
        await growVault(s);

        await openMemorySection(s);
        await (await s.byTestId("settings.memory.seed.open")).click();
        await runWizardToApplied(s);

        // Rebuild: the row now reads seeded, so its action asks for confirmation
        // first and names the previous date and count.
        await s.waitForElement(testIdSelector("settings.memory.seed-group"), { timeoutMs: 15_000 });
        await (await s.byTestId("settings.memory.seed.open")).click();
        await (await s.byTestId("settings.memory.seed.rebuild-confirm")).click();
        await s.waitForElement(testIdSelector("settings.memory.seed.scope"), {
          timeoutMs: 15_000,
        });
        await runWizardToApplied(s);

        await s.waitForElement(testIdSelector("settings.memory.seed-group"), { timeoutMs: 15_000 });
        expect(await s.byTestIdAll("settings.memory.seed-entry")).toHaveLength(3);
        await closeSettings(s);
      },
    );
  });
});
