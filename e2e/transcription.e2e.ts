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
//                   ABSENT (hidden-not-disabled; MYND-270 product tweak — no
//                   dangling affordance when the whole AI subsystem is off, see
//                   `editor/src/attachments/widgets.ts`). The other ⋮ rows still
//                   render, so the menu opens; only Transcribe is gone.
//
// Per `e2e/CLAUDE.md` definition of done a new/changed scenario must go green 3×
// consecutive via `./scripts/e2e-local.sh` before merge (it exercises the
// `local-inference|transcribe` IPC path + the audio-widget transcript surface
// through the ACL).
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
  unlockToEditor,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;

/** The id of the note currently open in the editor (the selected sidebar row). */
async function selectedNoteId(s: Session): Promise<string> {
  const row = await s.waitForElement('[data-testid="notes.row"][aria-current="true"]');
  const id = await row.attribute("data-note-id");
  if (id === null || id === "") {
    throw new Error("selected notes.row carried no data-note-id");
  }
  return id;
}

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

/** Embed the form-C audio reference into the current note, persist it, then reload
 *  so the editor's catalog cache re-reads and resolves the embed to the audio
 *  widget.
 *
 *  The body is written via production IPC (`note_read` + `note_update`), NOT
 *  `typeIntoEditor`: an `![[att:…]]` embed renders as an ATOMIC audio widget, so
 *  the typed characters are replaced by the widget in the live document and
 *  `typeIntoEditor`'s read-back verification can never match — it times out,
 *  re-sends, and doubles the text (the wikilink `[[` autocomplete compounds it).
 *  Seeding the body + reloading is the same robust pattern `wikilink-deep-links`
 *  uses for resolver-rendered content. */
async function embedAudioAndReopen(s: Session, id: string): Promise<void> {
  const noteId = await selectedNoteId(s);
  const cur = await pageSeatInvoke(s, "plugin:notes|note_read", { noteId }, IPC_TIMEOUT);
  const base = typeof cur.ok === "string" ? cur.ok : "";
  const up = await pageSeatInvoke(
    s,
    "plugin:notes|note_update",
    { noteId, plaintext: `${base}\n![[att:${id}|Voice note tr.wav]]` },
    IPC_TIMEOUT,
  );
  expect(up.err, "note_update should embed the audio attachment").toBeUndefined();
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

describeE2E("tr2 Transcribe row is absent (hidden) with AI off (transcription-ui)", () => {
  // Vault-count precondition: 1 (weak KDF). Runs on the DEFAULT build (no stub,
  // no model) — AI is off by default, so the row must be hidden-not-disabled.
  it("hides the Transcribe ⋮ row when AI is off", async () => {
    let seeded: SeededVault;
    await scenario(
      "tr2-transcribe-hidden",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);
        await createNote(s, "tr2notebravo7k2m9qx4w8e5rj0aa");

        const id = await recordFixtureAudio(s);
        await embedAudioAndReopen(s, id);

        // AI stays OFF (default). Open the audio ⋮ menu and assert the Transcribe
        // row is absent — hidden, not rendered-disabled, when the AI subsystem is
        // off (MYND-270). The menu is body-portaled and self-closes on any
        // scroll/resize reflow (`actionMenu.ts`), so a single click can race a
        // layout shift on a cold app; re-open until an ALWAYS-present row
        // (`reveal`) is visible, and — in that same open state — read Transcribe.
        // `transcribe` is read BEFORE `reveal` each poll: `reveal` present AFTER
        // the read proves the menu was open through both queries, so a count of 0
        // means the row is genuinely hidden, not that the menu closed mid-check.
        // The menu builds every row synchronously on open, so if Transcribe were
        // offered it would be present alongside `reveal`.
        // Returns a WRAPPER object (not the bare count): `waitUntil` only returns
        // a truthy result, and the success count here is 0 (falsy) — a bare return
        // would loop until timeout even on success.
        const read = await s.waitUntil(
          async () => {
            const transcribe = (await s.byTestIdAll("attachment-audio.transcribe")).length;
            const revealOpen = (await s.byTestIdAll("attachment-audio.reveal")).length > 0;
            if (!revealOpen) {
              // Menu not open (never opened, or a reflow closed it) — re-open.
              await (await s.byTestId("attachment-audio.menu-button")).click();
              return null;
            }
            return { transcribe };
          },
          { label: "audio ⋮ menu open, Transcribe row read", timeoutMs: 20_000 },
        );
        expect(read.transcribe, "Transcribe row is hidden while AI is off").toBe(0);
      },
    );
  });
});
