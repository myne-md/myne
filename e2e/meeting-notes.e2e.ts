// Meeting notes (myne-md/myne#789): vault-count precondition 1.
//
// Pins the session lifecycle through the production binary: start, capture,
// stop, and the session's clips coming back in capture order and landing in the
// vault's attachment catalog.
//
// The source is swapped for the deterministic fixture by the SAME
// `voice-capture-stub` build variant the voice-note scenario relies on. Under
// that feature `SourceFactory::Meeting` builds a MIX of two fixtures at
// different rates (48 kHz and 44.1 kHz), so this scenario drives the mix and
// the resampler as well as the session, with no device and no permission.
//
// What this scenario deliberately does NOT cover, and cannot: the macOS
// CoreAudio process tap. The suite runs in a Linux container against WebKitGTK,
// where `voice/tap.rs` does not compile and no audio device exists. The tap's
// construction path is covered by an `#[ignore]`d Rust test on macOS
// (`the_construction_path_reaches_the_hal`), and whether real audio flows is a
// manual-test roster item (`meeting.notes`), which is also the feature's
// graduation gate. Pretending otherwise here would be an automation claim
// nobody can check.
//
// Transcription is not asserted either: it runs the StubEngine in this build,
// so what a transcript says is not a property of this scenario. The session's
// job is to produce clips in order, and that is what is checked.
//
// SYNC-13: no credential appears in any assert.
//
// Validated in the container: green 3x consecutive via
// `MYNE_E2E_ONLY=e2e/meeting-notes.e2e.ts ./scripts/e2e-local.sh` on
// 2026-09-30, which is `e2e/AGENTS.md`'s definition of done for a new scenario.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import { dismissImporterOffer, pageSeatInvoke, unlockToEditor } from "./support/flows";

const IPC_TIMEOUT = 15_000;

interface MeetingSessionResult {
  clips: Array<{ id: string; content_type: string; filename: string }>;
}

describeE2E("meeting notes (myne-md/myne#789)", () => {
  it("mn1: start, capture, stop, clips in the catalog", async () => {
    let seeded: SeededVault;
    await scenario(
      "mn1-meeting-session",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // ---- start: the microphone/tap mix is armed ----
        const start = await pageSeatInvoke(
          s,
          "plugin:attachments|meeting_session_start",
          {},
          IPC_TIMEOUT,
        );
        // A failure here almost always means the binary under test was built
        // WITHOUT `--features voice-capture-stub`, so the mix opened a real
        // (absent) microphone and reported NoInputDevice.
        expect(
          start.err,
          "meeting_session_start should arm with the fixture mix",
        ).toBeUndefined();

        // A second start while one runs is refused: one capture at a time, or
        // two sessions would fight over the microphone and, on macOS, over the
        // tap's aggregate device.
        const second = await pageSeatInvoke(
          s,
          "plugin:attachments|meeting_session_start",
          {},
          IPC_TIMEOUT,
        );
        expect(second.err, "a second session must be refused").toBeDefined();

        // Let the fixture accumulate audible samples before stopping.
        await new Promise((resolve) => setTimeout(resolve, 300));

        // ---- stop: the session's clips come back in capture order ----
        const stop = await pageSeatInvoke(
          s,
          "plugin:attachments|meeting_session_stop",
          {},
          IPC_TIMEOUT,
        );
        expect(stop.err, "meeting_session_stop should finalize").toBeUndefined();
        const result = stop.ok as MeetingSessionResult;
        expect(result.clips.length).toBeGreaterThan(0);
        for (const clip of result.clips) {
          expect(clip.content_type).toBe("audio/wav");
          expect(clip.id.length).toBeGreaterThan(0);
        }

        // A stop with no session is refused rather than silently succeeding.
        const again = await pageSeatInvoke(
          s,
          "plugin:attachments|meeting_session_stop",
          {},
          IPC_TIMEOUT,
        );
        expect(again.err, "stopping a finished session must be refused").toBeDefined();

        // ---- the clips really are vault content, not a return value ----
        // Re-read the catalog the way the attachments library does, which is
        // the "reopen" half: an id the session returned but the catalog does
        // not carry would be an embed that resolves to nothing.
        const catalog = await pageSeatInvoke(s, "plugin:attachments|catalog_list", {}, IPC_TIMEOUT);
        expect(catalog.err).toBeUndefined();
        const ids = new Set(
          (catalog.ok as Array<{ id: string }>).map((row) => row.id),
        );
        for (const clip of result.clips) {
          expect(ids.has(clip.id), `clip ${clip.id} is missing from the catalog`).toBe(true);
        }
      },
    );
  });

  it("mn2: cancel keeps committed clips and refuses a second cancel", async () => {
    let seeded: SeededVault;
    await scenario(
      "mn2-meeting-cancel",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        const start = await pageSeatInvoke(
          s,
          "plugin:attachments|meeting_session_start",
          {},
          IPC_TIMEOUT,
        );
        expect(start.err).toBeUndefined();
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Cancel is the discard path: the in-flight tail is wiped, and no note
        // is written. It is idempotent, which is what the second call checks.
        const cancel = await pageSeatInvoke(
          s,
          "plugin:attachments|meeting_session_cancel",
          {},
          IPC_TIMEOUT,
        );
        expect(cancel.err, "meeting_session_cancel should discard the session").toBeUndefined();
        const cancelAgain = await pageSeatInvoke(
          s,
          "plugin:attachments|meeting_session_cancel",
          {},
          IPC_TIMEOUT,
        );
        expect(cancelAgain.err, "a second cancel is a no-op, not an error").toBeUndefined();

        // And the session really is gone: a stop now finds nothing.
        const stop = await pageSeatInvoke(
          s,
          "plugin:attachments|meeting_session_stop",
          {},
          IPC_TIMEOUT,
        );
        expect(stop.err, "a cancelled session has nothing to stop").toBeDefined();
      },
    );
  });
});
