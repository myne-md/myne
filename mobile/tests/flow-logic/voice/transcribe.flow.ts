// Flow-logic: the on-device transcription UI (MYND-563). Drives headless
// Chromium against the dev server with mock IPC — NOT an end-to-end suite (no
// device, no real Whisper model, no Rust). The `plugin:local-inference|transcribe`
// command is FAKED by the mock (canned transcript / a rejected EngineError kind),
// so the Transcribe row's idle → running → done / not-ready branches run
// deterministically. The real on-device transcription is the manual device-E2E
// exemption. Covers the repo policy that a new user-facing flow ships WITH a
// scenario + testids.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc, type MockConfig } from "../mock-ipc";

const AUDIO_ENTRY = {
  id: "aa".repeat(16),
  filename: "Voice note 1.wav",
  content_type: "audio/wav",
  size: 4096,
};

/** Boot the app to the unlocked editor with a seeded audio attachment, then open
 *  the Files library page (`workspace.tab-files`). Extra mock config (prefs,
 *  transcribe behaviour) is merged in. */
async function openFilesWithAudio(page: Page, extra: MockConfig = {}): Promise<void> {
  await installMockIpc(page, { syncStatus: { state: "idle" }, catalog: [AUDIO_ENTRY], ...extra });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
  await page.getByTestId("workspace.tab-files").click();
  await expect(page.getByTestId("files.page")).toBeVisible();
}

test.describe("on-device transcription UI (MYND-563)", () => {
  test("transcription on: Transcribe → streams a transcript to done", async ({ page }) => {
    await openFilesWithAudio(page, {
      prefs: { transcription_enabled: true },
      transcribe: { text: "the quick brown fox" },
    });

    // The row + its idle Transcribe button appear on the audio attachment.
    const row = page.getByTestId("files.transcribe-row");
    await expect(row).toBeVisible();
    await page.getByTestId("files.transcribe-start").click();

    // The done state renders the returned transcript (textContent, never HTML).
    const done = page.getByTestId("files.transcribe-done");
    await expect(done).toBeVisible();
    await expect(done).toContainText("the quick brown fox");
  });

  test("transcription off: the Transcribe row is hidden", async ({ page }) => {
    await openFilesWithAudio(page, { prefs: { transcription_enabled: false } });
    // The audio row still shows, but no Transcribe affordance.
    await expect(page.getByTestId("files.transcribe-row")).toHaveCount(0);
  });

  test("not-ready (no model): a select-a-model message, not a crash", async ({ page }) => {
    await openFilesWithAudio(page, {
      prefs: { transcription_enabled: true },
      transcribe: { error: "not_ready" },
    });
    await page.getByTestId("files.transcribe-start").click();
    const err = page.getByTestId("files.transcribe-error");
    await expect(err).toBeVisible();
    // The not-ready branch surfaces the "select a transcription model" hint.
    await expect(err).toContainText(/model/i);
  });

  test("failure: a retryable error message", async ({ page }) => {
    await openFilesWithAudio(page, {
      prefs: { transcription_enabled: true },
      transcribe: { error: "failed" },
    });
    await page.getByTestId("files.transcribe-start").click();
    await expect(page.getByTestId("files.transcribe-error")).toBeVisible();
    // Retry is offered — the idle Transcribe control is present again inside the error row.
    await expect(page.getByTestId("files.transcribe-error").getByRole("button")).toBeVisible();
  });

  test("too long: says so, and offers NO retry (myne#485)", async ({ page }) => {
    // The exact inverse of the `failed` case above, and the reason it is worth a
    // test of its own: the ceiling refuses the same clip every time, so a retry
    // button here would be advice that cannot work. A regression that
    // reintroduced the button would leave the `failed` assertion green and this
    // behaviour uncovered.
    await openFilesWithAudio(page, {
      prefs: { transcription_enabled: true },
      transcribe: { error: "too_long" },
    });
    await page.getByTestId("files.transcribe-start").click();
    const err = page.getByTestId("files.transcribe-error");
    await expect(err).toBeVisible();
    await expect(err).toContainText(/too long/i);
    // Not "is hidden": the button must not be in the row at all.
    await expect(err.getByRole("button")).toHaveCount(0);
  });
});
