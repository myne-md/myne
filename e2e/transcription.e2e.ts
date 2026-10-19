// Voice-to-text transcription flow suite (transcription-ui MYND-552 task 7).
//
// Drives the in-note audio-widget transcribe chain end-to-end through the REAL
// EditorHost `transcribe` slot + IPC (SYNC-V7), against the **`local-inference-
// stub` build variant** — gated on `MYNE_E2E_AI=1` (like `ai-ux-surface.e2e.ts`)
// so the deterministic StubEngine transcribe runs without a real Whisper model
// in the repo. A deterministic 440 Hz audio attachment comes from the record
// fixture, which since myne#389 is the compile-time `voice-capture-stub` build
// variant rather than an env knob (as `voice-notes.e2e.ts`). The full AI lane
// therefore wants BOTH: `--features local-inference-stub,voice-capture-stub`.
//
//   tr1 (gated) — seed a vault → record an audio note (fixture) → embed it →
//                 enable AI → trigger Transcribe from the audio ⋮ menu → assert
//                 the progress affordance → assert the read-only transcript
//                 expander renders the stub output → Insert into note → assert
//                 the note body now contains the transcript (SYNC-V1/V17).
//
//   tr2 (UNGATED) — the Transcribe ⋮ row follows `transcription_enabled`, NOT
//                   the AI opt-in (MYND-592). On the DEFAULT build the AI beta
//                   is off and the row is nonetheless PRESENT; turning the
//                   transcription switch off hides it (hidden-not-disabled,
//                   MYND-270 — no dangling affordance when the subsystem is
//                   off, see `editor/src/attachments/widgets.ts`). The other ⋮
//                   rows render throughout, so the menu opens either way.
//
// Per `e2e/AGENTS.md` definition of done a new/changed scenario must go green 3×
// consecutive via `./scripts/e2e-local.sh` before merge (it exercises the
// `local-inference|transcribe` IPC path + the audio-widget transcript surface
// through the ACL).
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  editorText,
  enableAi,
  setTranscriptionEnabled,
  pageSeatInvoke,
  reopenNoteAfterReload,
  runPaletteAction,
  selectedNoteId,
  unlockToEditor,
  writeNoteBody,
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
  // See `voice-notes.e2e.ts`: an error here is usually a binary built without
  // `--features voice-capture-stub`, not a broken record path.
  expect(
    stop.err,
    "voice_record_stop stores the recording — if this is an error, the binary was likely " +
      "built without `--features voice-capture-stub`",
  ).toBeUndefined();
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
  const up = await writeNoteBody(
    s,
    noteId,
    `${base}\n![[att:${id}|Voice note tr.wav]]`,
    IPC_TIMEOUT,
  );
  expect(up.err, "the audio embed write should succeed").toBeUndefined();
  await s.refresh();
  await reopenNoteAfterReload(s);
  // The inline audio player resolves once the catalog re-read completes.
  await s.waitForElement(testIdSelector("attachment-audio"), { timeoutMs: 15_000 });
}


/** Open the audio widget's ⋮ menu and click `testId`, RE-OPENING until the row
 *  is actually there.
 *
 * **A single click is not enough, and tr2 in this same file already knew.** Its
 * comment records that the menu is body-portaled and self-closes on any
 * scroll/resize reflow (`actionMenu.ts`), so one click can race a layout shift
 * on a cold app, and it polls with a re-open for exactly that reason. tr1 and
 * tr3 clicked once and then waited the full 45 s budget on a row that was never
 * going to appear, with nothing to re-click. That is the same shape
 * `e2e/AGENTS.md` records for `clickNewItem`: the victim looks like a broken
 * feature, and the fix is to re-fire the trigger rather than to wait longer. */
async function openAudioMenuItem(s: Session, testId: string): Promise<void> {
  const row = await s.waitUntil(
    async () => {
      const open = await s.byTestIdAll(testId);
      if (open.length > 0) return open[0];
      // Not up (or it closed under us) — fire the trigger again and re-poll.
      const button = (await s.byTestIdAll("attachment-audio.menu-button")).at(0);
      if (button !== undefined) await button.click();
      return null;
    },
    { label: `the audio menu showing ${testId}`, timeoutMs: 30_000 },
  );
  await row.click();
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
        await openAudioMenuItem(s, "attachment-audio.transcribe");

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

aiDescribe("tr3 attachments-library transcription viewer (#231)", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub
  // build. After an audio note is transcribed via the widget (which seals the
  // transcript into the attachment's MYE1 cache), the SAME transcript is
  // readable from the attachments library: opening the audio tile's ⋮ menu runs
  // the lazy `attachment_read_extracted_text` probe, which surfaces a "View
  // transcription" row that opens the read-only TranscriptionModal.
  it("shows a transcribed voice note's transcript in the library viewer modal", async () => {
    let seeded: SeededVault;
    await scenario(
      "tr3-transcription-viewer",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);
        await createNote(s, "tr3notecharlie7k2m9qx4w8e5rj0aa");

        // Record + embed a fixture audio note, then transcribe it via the widget
        // (this is what writes the MYE1 cache the library viewer reads back).
        const id = await recordFixtureAudio(s);
        await embedAudioAndReopen(s, id);
        await enableAi(s);
        await openAudioMenuItem(s, "attachment-audio.transcribe");
        const widgetTranscript = await (
          await s.waitForElement(testIdSelector("attachment-audio.transcript"), {
            timeoutMs: 20_000,
          })
        ).textContent();
        expect(widgetTranscript, "the stub transcribe produced text").not.toBe("");

        // Open the attachments library and the audio tile's ⋮ menu. The library
        // menu is not the body-portaled self-closing kind (al1 clicks its rows
        // directly), so one open is enough; "View transcription" appears once the
        // per-attachment extracted-text probe resolves.
        await runPaletteAction(s, "attachments.open", "attach");
        await s.byTestId("attachments.library");
        const tileMenu =
          testIdSelector("attachments.tile", { "data-id": id }) +
          " " +
          testIdSelector("attachments.actions-trigger");
        await (await s.waitForElement(tileMenu)).click();
        await (
          await s.waitForElement(testIdSelector("attachments.action-view-transcription"), {
            timeoutMs: 20_000,
          })
        ).click();

        // The read-only modal renders the same transcript the widget produced.
        await s.byTestId("attachments.transcription-modal");
        const modalText = await (await s.byTestId("attachments.transcription-text")).textContent();
        expect(modalText, "the library viewer shows a non-empty transcript").not.toBe("");
        expect(
          modalText.includes(widgetTranscript.slice(0, 12)),
          "the library transcript matches the widget's",
        ).toBe(true);
      },
    );
  });
});

describeE2E("tr2 the Transcribe row follows its OWN switch, not the AI opt-in (MYND-592)", () => {
  // Vault-count precondition: 1 (weak KDF). Runs on the DEFAULT build (no stub,
  // no model) — the AI opt-in is off, which is exactly the state that used to
  // hide this row and must no longer.
  it("offers Transcribe by default (AI off), and hides it once transcription is turned off", async () => {
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
        expect(
          read.transcribe,
          "Transcribe is offered by default, even though the AI opt-in is off",
        ).toBe(1);

        // Flip the real switch and read the same menu again — this half is what
        // proves the row is wired to this preference rather than merely
        // always-on. Close the ⋮ menu first: it is body-portaled and would sit
        // above the settings modal. The button toggles it; wait for a row that
        // is only present while it is open, so "closed" is observed, not hoped.
        await (await s.byTestId("attachment-audio.menu-button")).click();
        await s.waitForGone(testIdSelector("attachment-audio.reveal"));
        await setTranscriptionEnabled(s, false);

        const after = await s.waitUntil(
          async () => {
            const transcribe = (await s.byTestIdAll("attachment-audio.transcribe")).length;
            const revealOpen = (await s.byTestIdAll("attachment-audio.reveal")).length > 0;
            if (!revealOpen) {
              await (await s.byTestId("attachment-audio.menu-button")).click();
              return null;
            }
            return { transcribe };
          },
          { label: "audio ⋮ menu re-read after turning transcription off", timeoutMs: 20_000 },
        );
        expect(after.transcribe, "Transcribe is hidden once transcription is off").toBe(0);
      },
    );
  });
});
