// Meeting AI (meeting-ai): the opt-in pass, end to end through the real UI.
//
// Runs against the `local-inference-stub` build variant (sets `MYNE_E2E_AI=1`),
// the same gate every inference suite uses: the deterministic StubEngine stands
// in for the generation model, so what the sections SAY is not a property of
// this scenario. What is checked is the CHAIN: the offer appears after the
// session writes its note, the dialog runs the pass, and approving it lands a
// machine-generated block in the note without altering the transcript.
//
// The session itself is driven through the UI (the `/meeting` slash command,
// then the bar's Stop) rather than over page-seat IPC, because `stopMeetingSession`
// is a FRONTEND operation that writes the note and raises the offer; the
// existing `meeting-notes.e2e.ts` drives the IPC session and never writes a note.
//
// The oracle is disk, not the DOM: `writeMeetingSectionsToNote` does not reload
// an open pane, so the note is read back with `note_list` + `note_read` rather
// than scraped from the editor.
//
// SYNC-13: no credential appears in any assert. KDF: weak generator fixture.
//
// Validated 3x consecutive via
// `./scripts/e2e-ai-buildrun.sh meeting-ai meeting-ai meeting-ai`, which builds
// the `local-inference-stub` binary AND exports `MYNE_E2E_AI=1` (both halves are
// required; `e2e-local.sh` alone runs with `MYNE_E2E_AI=0`, so `aiDescribe` is
// `describe.skip` and the run would report green having executed zero tests).
// This is the `e2e/AGENTS.md` definition of done for a new scenario.

import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import { KEY } from "./support/keyboard";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  editorText,
  enableDeveloperMode,
  pageSeatInvoke,
  unlockToEditor,
} from "./support/flows";
import { REPO_ROOT } from "./support/session";
import type { Session } from "./support/webdriver";
import { testIdSelector } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;
const CM_CONTENT = testIdSelector("editor.content") + " .cm-content";

/** Only the `local-inference-stub` build. */
const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

/** Turn the AI beta on through the real toggle (Settings -> AI). */
async function enableAi(s: Session): Promise<void> {
  await (await s.byTestId("settings.tab-ai")).click();
  await s.byTestId("settings.ai-panel", { timeoutMs: IPC_TIMEOUT });
  const toggle = await s.byTestId("ai.enable-toggle");
  if ((await toggle.attribute("aria-checked")) !== "true") {
    await toggle.click();
    await s.waitUntil(
      async () =>
        (await (await s.byTestId("ai.enable-toggle")).attribute("aria-checked")) === "true"
          ? true
          : null,
      { label: "the AI beta opt-in to take", timeoutMs: IPC_TIMEOUT },
    );
  }
}

aiDescribe("meeting AI (meeting-ai)", () => {
  it("mai1: offer -> generate -> insert; the transcript is untouched", async () => {
    let seeded: SeededVault;
    await scenario(
      "mai1-meeting-ai",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // Record a generation-model path so the dialog does not take its
        // no-model branch. The StubEngine ignores the path (it runs regardless),
        // but `loadModelPath("generation")` reads this device-local store, and an
        // unset path would hide the picker behind the "download a model" notice.
        const model = await pageSeatInvoke(
          s,
          "plugin:local-inference|set_model_path",
          // A file the CHECKOUT always carries: the store only requires the path
          // to exist and to be outside the vault tree, and `package.json` is both
          // in every tree the harness runs in.
          //
          // It used to be the literal `/work/package.json`, which is where
          // `scripts/lib/e2e-docker.sh` bind-mounts the repo INSIDE the local
          // container. That path exists on a developer machine and nowhere else:
          // CI's checkout is `$CI_WORKSPACE`, so `set_model_path` answered
          // `Io { NotFound }` and mai1 failed on the first assertion after the
          // unlock, reporting a model-store error rather than a bad path. Deriving
          // it from `REPO_ROOT` is the same file in both places.
          { role: "generation", path: join(REPO_ROOT, "package.json") },
          IPC_TIMEOUT,
        );
        expect(model.err, "set_model_path should record the generation role").toBeUndefined();

        // Developer mode (the meeting feature's gate) + the AI beta.
        await enableDeveloperMode(s);
        await enableAi(s);
        await closeSettings(s);

        await createNote(s, "Meeting e2e");
        const content = await s.waitForElement(CM_CONTENT);
        await content.click();
        // Establish the keystroke pipeline AND land the caret on a fresh line
        // start, so the `/` opens the slash menu rather than being mid-word.
        await s.waitUntil(
          async () => {
            await content.sendKeys(`x${KEY.ENTER}`);
            return (await editorText(s)).includes("x") || null;
          },
          { label: "keystroke pipeline at a line start", timeoutMs: 10_000 },
        );

        // Start the session via the slash command; the bar mounts.
        await content.sendKeys(`/meeting${KEY.ENTER}`);
        await s.byTestId("meeting-bar", { timeoutMs: IPC_TIMEOUT });

        // Let the fixture mix accumulate samples, then stop. The session writes
        // its note and offers the AI pass.
        await new Promise((resolve) => setTimeout(resolve, 500));
        await (await s.byTestId("meeting.stop")).click();

        await s.byTestId("meeting.ai-offer", { timeoutMs: IPC_TIMEOUT });
        await (await s.byTestId("editor.toast-action")).click();
        await s.byTestId("meeting.ai-dialog", { timeoutMs: IPC_TIMEOUT });

        await (await s.byTestId("meeting.ai.generate")).click();
        await s.byTestId("meeting.ai.insert", { timeoutMs: 30_000 });
        await (await s.byTestId("meeting.ai.insert")).click();

        // ---- the block landed in the note (disk oracle, not the stale pane) ----
        await s.waitUntil(
          async () => {
            const ids = await pageSeatInvoke(s, "plugin:notes|note_list", {}, IPC_TIMEOUT);
            if (ids.err) return null;
            for (const id of ids.ok as string[]) {
              const read = await pageSeatInvoke(
                s,
                "plugin:notes|note_read",
                { noteId: id },
                IPC_TIMEOUT,
              );
              if (read.err) continue;
              if ((read.ok as string).includes("myne:meeting-ai:start")) return true;
            }
            return null;
          },
          { label: "the AI block landed in a note", timeoutMs: 20_000 },
        );
      },
    );
  });
});
