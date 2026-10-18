// Flow-logic: the voice-note recording flow (mobile voice notes). Drives headless
// Chromium against the dev server with mock IPC — NOT an end-to-end suite (no
// device, no real mic, no Rust). A real WKWebView/Android-WebView mic capture is
// the manual device-E2E exemption. Here the browser mic + Web Audio are FAKED
// (an init script) so the RecordingSheet → capture → WAV → `attachment_import`
// pipeline runs deterministically, and the permission-denied branch is exercised
// by rejecting `getUserMedia`.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** Inject a fake mic + Web Audio graph so `startVoiceCapture` succeeds headlessly
 *  and `stop()` yields non-empty PCM. `deny` rejects getUserMedia with
 *  NotAllowedError (the permission-denied path). Runs before the app boots. */
async function installFakeMedia(page: Page, opts: { deny?: boolean } = {}): Promise<void> {
  await page.addInitScript((deny: boolean) => {
    const fakeStream = { getTracks: () => [{ stop() {} }] };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          if (deny) {
            const e = new Error("denied");
            e.name = "NotAllowedError";
            throw e;
          }
          return fakeStream;
        },
      },
    });
    class FakeScriptProcessor {
      onaudioprocess: ((e: unknown) => void) | null = null;
      private timer: number | null = null;
      connect() {
        if (this.timer !== null) return;
        this.timer = window.setInterval(() => {
          this.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } });
        }, 30);
      }
      disconnect() {
        if (this.timer !== null) {
          window.clearInterval(this.timer);
          this.timer = null;
        }
      }
    }
    class FakeAudioContext {
      sampleRate = 16_000;
      destination = {};
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createScriptProcessor() {
        return new FakeScriptProcessor();
      }
      close() {
        return Promise.resolve();
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    (window as unknown as { webkitAudioContext: unknown }).webkitAudioContext = FakeAudioContext;
  }, opts.deny ?? false);
}

/** Open a fresh note via the widget deep-link capture (the app-side mechanism the
 *  iOS widget uses): `text` opens the editor only, `voice` opens the editor AND
 *  the recording sheet (`myne://capture?mode=voice`, the widget mic button).
 *  Waits for the app to boot to the main surface first, so the EditorFlow
 *  CAPTURE_EVENT listener is attached before the event fires. */
async function fireCapture(page: Page, mode: "text" | "voice"): Promise<void> {
  await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
  await page.evaluate(
    (m) => window.dispatchEvent(new CustomEvent("myne-deep-link-capture", { detail: { mode: m } })),
    mode,
  );
}

async function readImports(page: Page): Promise<Array<{ kind?: string; len: number; filename?: string | null }>> {
  const all = await page.evaluate(
    () => (window as unknown as { __voiceImports?: Array<{ kind?: string; len: number; filename?: string | null }> }).__voiceImports ?? [],
  );
  // The mock records EVERY attachment_import; the DEV test-data seeder
  // (lib/seed.ts) also imports its demo attachments through the same command
  // when it sees the mock's empty vault. Count only the recorder's own
  // `Voice note ….wav` imports — that is what these specs assert on.
  return all.filter((i) => i.filename?.startsWith("Voice note "));
}

test.describe("voice note recording", () => {
  test("FormatBar mic → record bar → Stop imports a Voice note .wav", async ({ page }) => {
    await installFakeMedia(page);
    await installMockIpc(page, { syncStatus: { state: "idle" } });
    await page.goto("/");

    await fireCapture(page, "text"); // open a fresh editor (no sheet yet)
    await page.getByLabel("Record voice note").click(); // the FormatBar mic button

    await expect(page.getByTestId("voice-record-bar")).toBeVisible();
    await page.waitForTimeout(150); // let a few audio frames accumulate
    await page.getByTestId("voice-record.stop").click();

    // The sheet closes and exactly one WAV import reached the backend, as one
    // STANDARD base64 string: that is the arm `importFile` sends from the phone
    // (`mobile/src/lib/attachments.ts`), and the mock measures it as decoded
    // bytes, so the length assertion below is still about the WAV.
    await expect(page.getByTestId("voice-record-bar")).toBeHidden();
    const imports = await readImports(page);
    expect(imports.length).toBe(1);
    expect(imports[0].kind).toBe("bytes_b64");
    expect(imports[0].len).toBeGreaterThan(44); // header (44) + at least some PCM
    expect(imports[0].filename).toMatch(/^Voice note .+\.wav$/);
  });

  test("widget mic deep-link (mode=voice) opens the recording sheet directly", async ({ page }) => {
    await installFakeMedia(page);
    await installMockIpc(page, { syncStatus: { state: "idle" } });
    await page.goto("/");

    await fireCapture(page, "voice"); // widget mic → fresh note + recording sheet

    await expect(page.getByTestId("voice-record-bar")).toBeVisible();
    await page.waitForTimeout(150);
    await page.getByTestId("voice-record.stop").click();

    await expect(page.getByTestId("voice-record-bar")).toBeHidden();
    expect((await readImports(page)).length).toBe(1);
  });

  test("permission denied → the SYS-02 microphone-off state", async ({ page }) => {
    await installFakeMedia(page, { deny: true });
    await installMockIpc(page, { syncStatus: { state: "idle" } });
    await page.goto("/");

    await fireCapture(page, "voice");

    await expect(page.getByTestId("voice-record.denied")).toBeVisible();
    await expect(page.getByText("Microphone access is off")).toBeVisible();
    expect((await readImports(page)).length).toBe(0); // no import attempted
  });
});
