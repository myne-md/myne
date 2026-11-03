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
  // The scope container renders before its two IPC reads answer, and Continue is
  // disabled until they do. A click at "the step is on screen" is a click on a
  // disabled button, which then reads as a generation that never started.
  await s.waitUntil(
    async () => {
      const loadError = await s.byTestIdAll("settings.memory.seed.load-error");
      if (loadError.length > 0) {
        throw new Error(`seed scope failed to load: ${await loadError[0]!.textContent()}`);
      }
      const button = await s.byTestId("settings.memory.seed.continue");
      return (await button.attribute("disabled")) === null ? true : null;
    },
    { label: "the seed scope is loaded", timeoutMs: 20_000 },
  );
  await (await s.byTestId("settings.memory.seed.continue")).click();
  // The stub answers phase one immediately; the candidate list is the proof the
  // whole two-phase contract (prompt, parse, review) ran. A run error returns the
  // wizard to the scope step, so wait for EITHER and report the cause rather
  // than a bare timeout.
  await s.waitUntil(
    async () => {
      const errors = await s.byTestIdAll("settings.memory.seed.run-error");
      if (errors.length > 0) {
        throw new Error(`seed run failed: ${await errors[0]!.textContent()}`);
      }
      const lists = await s.byTestIdAll("settings.memory.seed.candidate-list");
      return lists.length > 0 ? true : null;
    },
    { label: "the seed candidates appear", timeoutMs: 30_000 },
  );
  expect(await s.byTestIdAll("settings.memory.seed.candidate")).toHaveLength(3);
  await (await s.byTestId("settings.memory.seed.apply")).click();
  // Issue #970, item 11: there is no "Saved" step. The wizard closes itself and
  // the outcome is a toast, so the applied state is the wizard being gone plus
  // the toast naming the count.
  await s.waitForElement(testIdSelector("editor.toast"), { timeoutMs: 30_000 });
  await s.waitUntil(
    async () => (await s.byTestIdAll("settings.memory.seed.wizard")).length === 0,
    { label: "the wizard closes after saving", timeoutMs: 15_000 },
  );
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
        // Issue #970, item 8. The counts are chips, and the provider line names
        // the provider: it read "Provider: remote · remote" because the engine
        // reports its own id ("remote") and the class was appended after it.
        // Both are asserted on the real screen because both are copy defects no
        // unit test can see rendered.
        expect(
          await (await s.byTestId("settings.memory.seed.count-notes")).textContent(),
        ).toContain("notes");
        expect(
          await (await s.byTestId("settings.memory.seed.count-folders")).textContent(),
        ).toContain("folders");
        expect(
          await (await s.byTestId("settings.memory.seed.count-tags")).textContent(),
        ).toContain("tags");
        expect(
          await (await s.byTestId("settings.memory.seed.provider")).textContent(),
        ).toBe("Provider: on this device");
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
        // first and names the previous date and count. Wait for the row's own
        // reload, not only the list's: the two reads race, and a click on the
        // pre-reload row opens a first-seed wizard instead of the confirmation.
        await s.waitForElement(testIdSelector("settings.memory.seed-group"), { timeoutMs: 15_000 });
        await s.waitForElement(
          testIdSelector("settings.memory.seed-row", { "data-seeded": "true" }),
          { timeoutMs: 15_000 },
        );
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
