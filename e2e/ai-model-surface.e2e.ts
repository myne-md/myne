// The AI model surface: the download catalogue and the three role rows
// (myne-md/myne#867).
//
// == WHAT THIS PROVES, AND WHAT IT DOES NOT ==
// Three scenarios over the REAL panel on the `local-inference-stub` build:
//
//   aims1: the catalogue is INLINE in the Models topic (myne-md/myne#885 moved it
//           out of the modal myne-md/myne#867 opened from the Models heading),
//           and it lists every model Myne's own origin serves, with its size and
//           its state. The Models block carries one assignment row per role,
//           INCLUDING the tag role, which had no row at all before this change:
//           it was reachable only by downloading it.
//   aims2: the row's **Download button is wired**. Pressing it sends the real
//           command to the host, and what is asserted is the request the host
//           made, counted by the pinned fixture origin. An unwired button
//           presses into nothing and the count stays zero.
//   aims3: an installed model shows as **Installed** with its provenance, and
//           **Remove** forgets it: the row goes back to **Not installed** and
//           the host's stored path for the role is gone.
//
// **The button's SUCCESS path is deliberately not driven, and this is the
// reason.** The catalogue names the artefact Myne's own origin serves (`tag`)
// with the production URL and the production digest compiled into the binary.
// The harness serves ONE stub-only artefact (`fixture-tag`, whose digest is the
// digest of the fixture bytes), and `download.rs::artifact_by_id` resolves a
// production id from the PRODUCTION table first. So pointing the button at
// fixture bytes would mean compiling a stub-only digest over a production id: a
// stub build that accepts the wrong bytes for a real artefact, which is exactly
// the trust anchor `mdo3` asserts it cannot do. The download itself is therefore
// driven through the same IPC command the button calls (`aims3`), the refusal
// path is `mdo3`'s, and what this file adds is the SURFACE: reachable, honest
// about state, and wired.
//
// Gated on `MYNE_E2E_AI=1` AND the stub build, paired by
// `scripts/e2e-ai-buildrun.sh`, like its neighbours in this directory.

import { describe, expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  dismissImporterOffer,
  enableAi,
  ipcOk,
  openSettings,
  selectSettingsTopic,
  unlockToEditor,
} from "./support/flows";
import { startFakeModelOrigin } from "./support/model-fixture-origin";
import type { Session } from "./support/webdriver";

const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

/**
 * The two state labels, BY VALUE.
 *
 * Duplicated from `locales/en/common.json` rather than imported, for the reason
 * `clipboard-copy.e2e.ts` records: this suite drives the production BUNDLE, so
 * importing the catalog would assert the test's copy of the string against
 * itself. A rewording that lands in the catalog and not here fails this
 * scenario, which is what should happen to a word the user reads on the row it
 * decides.
 */
const INSTALLED = "Installed";
const NOT_INSTALLED = "Not installed";
/** The transport-failure sentence, by value, same reasoning. */
const DOWNLOAD_FAILED = "The download did not finish.";

/** Open the AI panel, take the beta opt-in, and land on the Models topic, where
 *  the catalogue table is (myne-md/myne#885: it is inline, so there is no modal
 *  to open and no button to press).
 *
 *  **The panel has to be REOPENED after `enableAi`, and the first version of this
 *  helper did not do it.** `enableAi` chains `enableDeveloperMode` then
 *  `setSettingsSwitch`, and `setSettingsSwitch` ends by CLOSING the modal
 *  (`closeSettings`), so waiting for a control inside it afterwards waits for a
 *  panel that is not on screen. The result was all three scenarios timing out on
 *  `ai.catalogue-button` for 45 s, which is the failure a scenario written and
 *  never run always has; `openSettings` is idempotent on an open modal, so this is
 *  one line rather than a state machine. */
async function openCatalogue(s: Session): Promise<void> {
  await enableAi(s);
  await openSettings(s, "ai");
  await s.byTestId("settings.ai-panel");
  // The catalogue and the three assignment rows this file drives live in the
  // Models topic; the tag row moved to Tagging.
  await selectSettingsTopic(s, "ai", "models");
  await s.waitUntil(async () => (await s.byTestIdAll("ai.catalogue")).at(0) ?? null, {
    label: "the download catalogue",
    timeoutMs: 15_000,
  });
}

/** A row's state text: `Installed` or `Not installed`. */
async function rowState(s: Session, artifact: string): Promise<string> {
  return (await (await s.byTestId(`ai.download-state-${artifact}`)).textContent()).trim();
}

/** The stored path for a model-store role, over production IPC. */
async function rolePath(s: Session, role: string): Promise<string | null> {
  const out = await ipcOk(s, "plugin:local-inference|get_model_path", { role });
  return out as string | null;
}

/** Install the harness's own artefact through the REAL download command, the
 *  same one the catalogue's button calls. Returns the installed path. */
async function installFixture(s: Session, downloadId: string): Promise<string> {
  return (await ipcOk(
    s,
    "plugin:local-inference|download_model",
    { artifact: "fixture-tag", downloadId },
    60_000,
  )) as string;
}

aiDescribe("aims AI model surface (catalogue + role assignment)", () => {
  it("aims1 every role has a row, and the catalogue is listed inline in the Models topic", async () => {
    let password = "";
    await scenario(
      "aims1-catalogue-and-roles",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await enableAi(s);
        await openSettings(s, "ai");
        await s.byTestId("settings.ai-panel");
        await selectSettingsTopic(s, "ai", "models");

        // The Models table's three role rows, by their own controls. The tag row
        // is the one myne-md/myne#867 added; without it the tag model was
        // reachable only by downloading it, and a user with their own file had
        // no way to point Myne at it.
        for (const role of ["", "-transcription", "-tag"]) {
          await s.byTestId(`ai.model-choose${role}`);
        }

        // **The catalogue, INLINE in the Models topic.** There is no button to
        // press and no modal: it is in the same topic as the assignment rows,
        // which is what the requester asked for ("list the models the way the
        // other model rows are listed"). Asserted in both directions, so a
        // catalogue that went back behind a press fails here.
        await selectSettingsTopic(s, "ai", "models");
        await s.waitUntil(async () => (await s.byTestIdAll("ai.catalogue")).at(0) ?? null, {
          label: "the download catalogue, inline in the Models topic",
          timeoutMs: 15_000,
        });
        expect((await s.byTestIdAll("ai.catalogue-button")).length).toBe(0);

        // **The artefact, whether or not it is installed**, which is the point
        // of a catalogue over a "download" block: what Myne offers cannot
        // depend on what this machine happens to have.
        for (const artifact of ["tag"]) {
          const row = await s.byTestId(`ai.download-row-${artifact}`);
          expect(await row.textContent()).not.toBe("");
          expect(await rowState(s, artifact)).toBe(NOT_INSTALLED);
        }
      },
    );
  });

  it("aims2 the row's Download button sends the real command, and its failure is named", async () => {
    // The origin is PINNED to the fixture, so the request the button causes goes
    // to 127.0.0.1 and nowhere else. The fixture 404s the production path, which
    // is what makes this the WIRING assertion rather than a download assertion.
    const origin = await startFakeModelOrigin();
    try {
      let password = "";
      await scenario(
        "aims2-download-button-is-wired",
        {
          seed: (dir) => void (password = seedVault(dir).password),
          env: { MYNE_E2E_MODEL_ORIGIN: origin.origin },
        },
        async (app) => {
          const s = app.session;
          await unlockToEditor(s, password);
          await dismissImporterOffer(s);
          await openCatalogue(s);

          const before = origin.requests();
          const button = await s.byTestId("ai.download-button-tag");
          await button.click();

          // **A request is what proves the button is wired.** An unwired button
          // is a click that reaches nothing: no command, no transport, no
          // request, and this count stays at `before` while the row looks
          // exactly the same.
          await s.waitUntil(async () => (origin.requests() > before ? true : null), {
            label: "the download command to reach the pinned origin",
            timeoutMs: 20_000,
          });

          // The failure is NAMED rather than silent (a download that died
          // leaving no trace is the shape this row must not have), and the row
          // comes back to its offerable state rather than sticking in
          // "Downloading".
          await s.waitUntil(
            async () => {
              const row = await s.byTestId("ai.download-row-tag");
              return (await row.textContent()).includes(DOWNLOAD_FAILED) ? true : null;
            },
            { label: "the failure to be named on the row", timeoutMs: 20_000 },
          );
          await s.waitUntil(
            async () => (await s.byTestIdAll("ai.download-button-tag")).at(0) ?? null,
            { label: "the download action to return", timeoutMs: 20_000 },
          );
          expect(await rowState(s, "tag")).toBe(NOT_INSTALLED);
        },
      );
    } finally {
      await origin.close();
    }
  });

  it("aims3 shows an installed model, and Remove forgets it", async () => {
    const origin = await startFakeModelOrigin();
    try {
      let password = "";
      await scenario(
        "aims3-installed-then-removed",
        {
          seed: (dir) => void (password = seedVault(dir).password),
          env: { MYNE_E2E_MODEL_ORIGIN: origin.origin },
        },
        async (app) => {
          const s = app.session;
          await unlockToEditor(s, password);
          await dismissImporterOffer(s);

          // Installed BEFORE the panel opens, so the panel's own read of the
          // stored paths (one per role, taken when it mounts) sees it. A
          // download started from the UI reloads the same map through its own
          // `onChanged`, which is why `aims2`'s row recovers without this.
          const installed = await installFixture(s, "aims3");
          expect(await rolePath(s, "tag")).toBe(installed);

          await openCatalogue(s);
          expect(await rowState(s, "tag")).toBe(INSTALLED);
          // **The provenance is the PATH, and it is behind the row's own press.**
          // `ai.model-provenance-<artifact>` is the ICON BUTTON, so its own text is
          // empty by construction; the path renders in the anchored panel the press
          // opens, and the panel only exists while it is open. The first version
          // asserted non-empty text on the button and failed at 45 s on the one
          // assertion in this file that could not pass, which is what running a
          // scenario once is for.
          const provenance = await s.byTestId("ai.model-provenance-tag");
          await (await provenance.click(), s.waitUntil(
            async () =>
              (await s.byTestIdAll("ai.model-provenance-panel-tag")).at(0) ?? null,
            { label: "the provenance panel", timeoutMs: 15_000 },
          ));
          const shown = await s.byTestId("ai.model-provenance-panel-tag-path");
          expect((await shown.textContent()).trim()).toBe(installed);

          const remove = await s.byTestId("ai.remove-button-tag");
          await remove.click();

          // Gone from the host as well as from the row: this is the assertion
          // that separates "the row redrew" from "the model was forgotten".
          await s.waitUntil(
            async () => ((await rolePath(s, "tag")) === null ? true : null),
            { label: "the stored tag path to clear", timeoutMs: 15_000 },
          );
          await s.waitUntil(
            async () => ((await rowState(s, "tag")) === NOT_INSTALLED ? true : null),
            { label: "the row to return to Not installed", timeoutMs: 15_000 },
          );
        },
      );
    } finally {
      await origin.close();
    }
  });
});
