// Voice-to-text transcription flow suite (transcription-ui MYND-552 task 7).
//
// Drives the in-note audio-widget transcribe chain end-to-end through the REAL
// EditorHost `transcribe` slot + IPC (SYNC-V7), against the **`local-inference-
// stub` build variant** — gated on `MYNE_E2E_AI=1` (like `ai-ux-surface.e2e.ts`)
// so the deterministic StubEngine transcribe runs without a real Whisper model
// in the repo. A deterministic 440 Hz audio attachment comes from the record
// fixture (`MYNE_E2E_AUDIO_FIXTURE`, as `voice-notes.e2e.ts`).
//
//   tr1 (gated) — seed a vault → record an audio note (fixture) → embed it →
//                 enable AI → trigger Transcribe from the audio ⋮ menu → assert
//                 the progress affordance → assert the read-only transcript
//                 expander renders the stub output → Insert into note → assert
//                 the note body now contains the transcript (SYNC-V1/V17).
//
//   tr2 (UNGATED) — on the DEFAULT build (AI off), the Transcribe ⋮ row is
//                   PRESENT but DISABLED (disabled-not-hidden; SYNC-V7) — no call
//                   to an unregistered command. Mirrors `ai-labs-beta.e2e.ts`.
//
// ⚠️ NEW SCENARIO — authored but NOT yet validated in the container. Per
// `e2e/CLAUDE.md` definition of done it must go green 3× consecutive via
// `./scripts/e2e-local.sh` before merge (it exercises the `local-inference|
// transcribe` IPC path + the audio-widget transcript surface through the ACL).
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

// The launched binary inherits process.env (session launchApp), so this selects
// the deterministic fixture capture source for every launch in this file.
process.env.MYNE_E2E_AUDIO_FIXTURE = "1";

import { describe, expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  editorText,
  enableAi,
  pageSeatInvoke,
  reopenNoteAfterReload,
  typeIntoEditor,
  unlockToEditor,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;

/** Only run the deterministic-inference slice against the `local-inference-stub`
 *  build (sets `MYNE_E2E_AI=1`) — the StubEngine transcribe is stable without a
 *  model file (the transcribe command + audio widget ship in the default bundle
 *  too; the disabled-row check below is ungated). */
const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

/** Record a deterministic fixture voice note and return its attachment id. */
async function recordFixtureAudio(s: Session): Promise<string> {
  const start = await pageSeatInvoke(s, "plugin:attachments|voice_record_start", {}, IPC_TIMEOUT);
  expect(start.err, "voice_record_start arms with the fixture source").toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stop = await pageSeatInvoke(
    s,
    "plugin:attachments|voice_record_stop",
    { filename: "Voice note tr.wav" },
    IPC_TIMEOUT,
  );
  expect(stop.err, "voice_record_stop stores the recording").toBeUndefined();
  const imported = stop.ok as { id: string } | null;
  expect(imported, "a non-empty fixture recording returns the final clip").not.toBeNull();
  return (imported as { id: string }).id;
}

/** Type the form-C audio embed into the current note, persist it, then reload so
 *  the editor's catalog cache re-reads and resolves the embed to the audio
 *  widget. */
async function embedAudioAndReopen(s: Session, id: string): Promise<void> {
  await typeIntoEditor(s, `![[att:${id}|Voice note tr.wav]]`);
  await s.refresh();
  await reopenNoteAfterReload(s);
  // The inline audio player resolves once the catalog re-read completes.
  await s.waitForElement(testIdSelector("attachment-audio"), { timeoutMs: 15_000 });
}

aiDescribe("tr1 transcribe chain — progress → transcript → insert (transcription-ui)", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("transcribes an embedded audio note and inserts the transcript into the note body", async () => {
    let seeded: SeededVault;
    await scenario(
      "tr1-transcription",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);
        await createNote(s, "tr1notealpha7k2m9qx4w8e5rj0aa");

        // Record a fixture audio note + embed it so the inline player renders.
        const id = await recordFixtureAudio(s);
        await embedAudioAndReopen(s, id);

        // AI opt-in on (SYNC-12) — enables the Transcribe row (facet true).
        await enableAi(s);

        // ── Trigger Transcribe from the audio ⋮ menu ──
        await (await s.byTestId("attachment-audio.menu-button")).click();
        await (await s.waitForElement(testIdSelector("attachment-audio.transcribe"))).click();

        // Progress affordance appears while the stub streams segments.
        await s.waitForElement(testIdSelector("attachment-audio.transcript-progress"), {
          timeoutMs: 15_000,
        });

        // The read-only transcript expander renders the stub output.
        const transcriptEl = await s.waitForElement(testIdSelector("attachment-audio.transcript"), {
          timeoutMs: 20_000,
        });
        const transcript = await transcriptEl.textContent();
        expect(transcript, "the stub transcribe produced non-empty text").not.toBe("");

        // ── Insert into note → the transcript lands in the note body (SYNC-V17) ──
        await (await s.byTestId("attachment-audio.transcript-edit")).click();
        await s.waitUntil(
          async () => ((await editorText(s)).includes(transcript.slice(0, 12)) ? true : null),
          { label: "transcript inserted into the note body", timeoutMs: 10_000 },
        );
      },
    );
  });
});

describeE2E("tr2 Transcribe row is present-but-disabled with AI off (transcription-ui)", () => {
  // Vault-count precondition: 1 (weak KDF). Runs on the DEFAULT build (no stub,
  // no model) — AI is off by default, so the row must be disabled-not-hidden.
  it("shows a disabled Transcribe ⋮ row when AI is off", async () => {
    let seeded: SeededVault;
    await scenario(
      "tr2-transcribe-disabled",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);
        await createNote(s, "tr2notebravo7k2m9qx4w8e5rj0aa");

        const id = await recordFixtureAudio(s);
        await embedAudioAndReopen(s, id);

        // AI stays OFF (default). Open the audio ⋮ menu and assert the Transcribe
        // row is present AND disabled (no unregistered-command call possible).
        await (await s.byTestId("attachment-audio.menu-button")).click();
        const row = await s.waitForElement(testIdSelector("attachment-audio.transcribe"));
        expect(await row.enabled(), "Transcribe row is disabled while AI is off").toBe(false);
      },
    );
  });
});
