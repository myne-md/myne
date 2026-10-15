// Flow-logic: the audio-transcript reader (myne-md/myne#886). Drives headless
// Chromium against the dev server with mock IPC, so it is NOT an end-to-end
// suite (no device, no real Whisper model, no Rust). The `plugin:local-inference|*`
// commands are FAKED by the mock, so the sheet's cache-read → idle → running →
// done / error branches run deterministically, and the copy/save/insert actions
// are observable through the mock's recorders.
//
// It replaces the inline `TranscribeRow` spec (MYND-563) that this change
// deleted: the row widget is gone, and the transcript now lives in a sheet whose
// own testids this file drives.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc, type MockConfig } from "../mock-ipc";

const AUDIO_ID = "aa".repeat(16);
const AUDIO_ENTRY = {
  id: AUDIO_ID,
  filename: "Voice note 1.wav",
  content_type: "audio/wav",
  size: 4096,
};

/** Boot the app to the unlocked editor with a seeded audio attachment, then open
 *  the Files library page (`workspace.tab-files`). Extra mock config (prefs,
 *  transcribe behaviour, cached transcript) is merged in. */
async function openFilesWithAudio(page: Page, extra: MockConfig = {}): Promise<void> {
  await installMockIpc(page, { syncStatus: { state: "idle" }, catalog: [AUDIO_ENTRY], ...extra });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
  await page.getByTestId("workspace.tab-files").click();
  await expect(page.getByTestId("files.page")).toBeVisible();
}

/** Tap the audio row (its filename block is the control) to open the sheet. */
async function openTranscriptSheet(page: Page): Promise<void> {
  await page.getByTestId("files.row-open").first().click();
  await expect(page.getByTestId("files.transcript-sheet")).toBeVisible();
}

const clipboardWrites = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __clipboardWrites?: string[] }).__clipboardWrites ?? [],
  );

const createdNotes = (page: Page) =>
  page.evaluate(() => (window as unknown as { __noteCreates?: string[] }).__noteCreates ?? []);

test.describe("audio transcript reader (myne-md/myne#886)", () => {
  test("no cached transcript: the sheet opens idle, Transcribe → done", async ({ page }) => {
    await openFilesWithAudio(page, {
      prefs: { transcription_enabled: true },
      transcribe: { text: "the quick brown fox" },
    });
    await openTranscriptSheet(page);

    // No cache → the idle Transcribe affordance, inside the sheet rather than
    // strewn under the row.
    await expect(page.getByTestId("files.transcript-start")).toBeVisible();
    await page.getByTestId("files.transcript-start").click();

    const done = page.getByTestId("files.transcript-done");
    await expect(done).toBeVisible();
    await expect(page.getByTestId("files.transcript-text")).toHaveText("the quick brown fox");
    // The fallibility note ships WITH the transcript, verbatim (SYNC-8).
    await expect(page.getByTestId("files.transcript-disclaimer")).toContainText(
      "may be wrong",
    );
  });

  test("cached transcript: the sheet opens straight to done, no re-run", async ({ page }) => {
    await openFilesWithAudio(page, {
      prefs: { transcription_enabled: true },
      readTranscript: "an already-cached transcript",
    });
    await openTranscriptSheet(page);

    // Read BEFORE running: the cache is shown, and the run action is not the
    // sheet's primary affordance any more.
    await expect(page.getByTestId("files.transcript-text")).toHaveText(
      "an already-cached transcript",
    );
    await expect(page.getByTestId("files.transcript-start")).toHaveCount(0);
    // Desktop keeps Transcribe beside View transcription so a model swap can
    // re-derive an existing transcript; so does this sheet.
    await expect(page.getByTestId("files.transcript-retranscribe")).toBeVisible();
  });

  test("running streams segments with a progress indicator, joined as paragraphs", async ({
    page,
  }) => {
    await openFilesWithAudio(page, {
      prefs: { transcription_enabled: true },
      transcribe: { text: "one two" },
      transcribeSegments: ["one", "two"],
      transcribeDelayMs: 400,
    });
    await openTranscriptSheet(page);
    await page.getByTestId("files.transcript-start").click();

    // The running state is a real state, not a frame: label + spinner + the
    // streamed preview.
    const running = page.getByTestId("files.transcript-running");
    await expect(running).toBeVisible();
    await expect(running).toContainText("Transcribing");

    await expect(page.getByTestId("files.transcript-done")).toBeVisible();
    // Segments are joined at phrase boundaries rather than concatenated into one
    // run-on block (`toHaveText` collapses whitespace, so read the raw text).
    const joined = await page.getByTestId("files.transcript-text").textContent();
    expect(joined).toContain("one\n\ntwo");
  });

  test("copy puts the transcript on the clipboard", async ({ page }) => {
    await openFilesWithAudio(page, {
      prefs: { transcription_enabled: true },
      readTranscript: "copy me verbatim",
    });
    await openTranscriptSheet(page);
    await page.getByTestId("files.transcript-copy").click();

    expect(await clipboardWrites(page)).toContain("copy me verbatim");
    await expect(page.getByTestId("toast.host")).toContainText("Transcript copied");
  });

  test("save as note writes the embed + transcript, then opens the note", async ({ page }) => {
    await openFilesWithAudio(page, {
      prefs: { transcription_enabled: true },
      readTranscript: "saved transcript body",
    });
    await openTranscriptSheet(page);
    await page.getByTestId("files.transcript-save").click();

    const created = await createdNotes(page);
    // The dev-only seed writes notes into an empty vault, so the transcript's own
    // create is the one carrying our text rather than necessarily the only one.
    const body = created.find((b) => b.includes("saved transcript body"));
    expect(body).toBeDefined();
    // The meeting-note pattern: the audio travels with its transcript.
    expect(body).toContain(`![[att:${AUDIO_ID}]]`);
    expect(body).toContain("## Transcript");
    // The caller's onSavedNote hand-off ran: the Files page is gone because the
    // save switches to the notes tab and opens the new note.
    await expect(page.getByTestId("files.page")).toHaveCount(0);
  });

  test("insert into note: the in-editor sheet appends the transcript", async ({ page }) => {
    const NOTE_ID = "note-transcript-insert";
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      catalog: [AUDIO_ENTRY],
      notes: [{ id: NOTE_ID, text: "---\ntitle: Draft\n---\n\nSome text.\n" }],
      prefs: { transcription_enabled: true },
      readTranscript: "inserted transcript body",
    });
    await page.goto("/");
    // Open the note so the editor (and its format bar) mount, then the in-editor
    // attachments sheet through the bar's library action.
    await page.getByTestId("notes.row").first().click();
    await page.getByRole("button", { name: "Insert from library" }).click();
    await page.getByTestId("files.row-open").first().click();
    await expect(page.getByTestId("files.transcript-sheet")).toBeVisible();
    await page.getByTestId("files.transcript-insert").click();

    // Both sheets close and the transcript is in the open note.
    await expect(page.getByTestId("files.transcript-sheet")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toContainText("inserted transcript body");
  });

  test("transcription off, nothing cached: the sheet says so instead of offering a run", async ({
    page,
  }) => {
    await openFilesWithAudio(page, { prefs: { transcription_enabled: false } });
    // The row is still a control: reading a cached transcript needs no engine, so
    // the row cannot be gated on the producer's switch.
    await openTranscriptSheet(page);
    await expect(page.getByTestId("files.transcript-off")).toBeVisible();
    await expect(page.getByTestId("files.transcript-start")).toHaveCount(0);
  });

  test("transcription off, cached transcript: still readable", async ({ page }) => {
    // The desktop rule, and the reason the row stays tappable: the pref hides the
    // Transcribe ACTION, never an already-produced transcript.
    await openFilesWithAudio(page, {
      prefs: { transcription_enabled: false },
      readTranscript: "readable with the engine off",
    });
    await openTranscriptSheet(page);
    await expect(page.getByTestId("files.transcript-text")).toHaveText(
      "readable with the engine off",
    );
    await expect(page.getByTestId("files.transcript-start")).toHaveCount(0);
    // The run action IS gated, because it needs the engine.
    await expect(page.getByTestId("files.transcript-retranscribe")).toHaveCount(0);
  });

  test("not-ready (no model): a select-a-model message, not a crash", async ({ page }) => {
    await openFilesWithAudio(page, {
      prefs: { transcription_enabled: true },
      transcribe: { error: "not_ready" },
    });
    await openTranscriptSheet(page);
    await page.getByTestId("files.transcript-start").click();
    const err = page.getByTestId("files.transcript-error");
    await expect(err).toBeVisible();
    await expect(err).toContainText(/model/i);
  });

  test("failure: a retryable error message", async ({ page }) => {
    await openFilesWithAudio(page, {
      prefs: { transcription_enabled: true },
      transcribe: { error: "failed" },
    });
    await openTranscriptSheet(page);
    await page.getByTestId("files.transcript-start").click();
    const err = page.getByTestId("files.transcript-error");
    await expect(err).toBeVisible();
    // Retry is offered inside the error row.
    await expect(err.getByRole("button")).toBeVisible();
  });

  test("too long: says so, and offers NO retry (myne#485)", async ({ page }) => {
    // The exact inverse of the `failed` case above: the ceiling refuses the same
    // clip every time, so a retry button would be advice that cannot work.
    await openFilesWithAudio(page, {
      prefs: { transcription_enabled: true },
      transcribe: { error: "too_long" },
    });
    await openTranscriptSheet(page);
    await page.getByTestId("files.transcript-start").click();
    const err = page.getByTestId("files.transcript-error");
    await expect(err).toBeVisible();
    await expect(err).toContainText(/too long/i);
    await expect(err.getByRole("button")).toHaveCount(0);
  });
});
