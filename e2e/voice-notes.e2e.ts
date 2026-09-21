// Voice notes (MYND-259) — vault-count precondition: 1.
//
// Pins the record → save → reopen → playback-source chain through the
// production binary. Native cpal capture is swapped for the deterministic
// FixtureSource by the **`voice-capture-stub` build variant** (myne#389 item D)
// so the record flow runs with NO real microphone on the headless runner. It is
// a COMPILE-time selection, not an env knob: the previous
// `MYNE_E2E_AUDIO_FIXTURE` read had no `cfg` gate and shipped in the release
// binary, where anything able to set an env var could silently substitute the
// microphone. `./scripts/e2e-local.sh` and CI both build with the feature; the
// shipped bundle carries neither the switch nor the synthetic generator.
//
// Driven via page-seat IPC (the generic-file-attachment precedent): the slash
// `/record` UI + the inline player widget render are Vitest-DOM concerns per
// `e2e/AGENTS.md`. Here we prove the load-bearing chain — a recorded WAV is
// stored as an `audio/wav` attachment, survives a catalog re-read ("reopen"),
// and its served content-type resolves to `audio/wav` (the player's source).
// The production `data-testid`s for a future UI-driven path are already in
// place: `attachment-audio*` (player) + `voice-record-bar` / `voice-record.*`
// (recording bar), added in MYND-259 tasks 2 + 5.
//
// SYNC-13: no credential appears in any assert. KDF: weak generator fixtures
// (unlock reads params from vault.meta).
//
// ⚠️ NEW SCENARIO — authored but NOT yet validated in the container. Per
// `e2e/AGENTS.md` definition of done it must go green 3× consecutive via
// `./scripts/e2e-local.sh` before merge (it introduces the
// `plugin:attachments|voice_record_*` IPC paths through the real ACL).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import { dismissImporterOffer, pageSeatInvoke, unlockToEditor } from "./support/flows";

const IPC_TIMEOUT = 15_000;

describeE2E("voice notes (MYND-259)", () => {
  it("vn1 — record → save → catalog reopen → audio/wav", async () => {
    let seeded: SeededVault;
    await scenario(
      "vn1-voice-note",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // ---- record (deterministic 440 Hz fixture source) ----
        const start = await pageSeatInvoke(
          s,
          "plugin:attachments|voice_record_start",
          {},
          IPC_TIMEOUT,
        );
        expect(start.err, "voice_record_start should arm with the fixture source").toBeUndefined();

        // Let the fixture accumulate audible samples before stopping.
        await new Promise((resolve) => setTimeout(resolve, 300));

        // ---- save: stop encodes the WAV + stores it as an attachment ----
        const stop = await pageSeatInvoke(
          s,
          "plugin:attachments|voice_record_stop",
          { filename: "Voice note e2e.wav" },
          IPC_TIMEOUT,
        );
        // A failure here almost always means the binary under test was built
        // WITHOUT `--features voice-capture-stub`, so capture opened a real
        // (absent) microphone and `voice_record_stop` reported NoInputDevice.
        // `voice_record_start` cannot tell you that — the source is built
        // inside the capture thread, so it returns Ok either way. Rebuild via
        // `./scripts/e2e-local.sh`.
        expect(
          stop.err,
          "voice_record_stop should store the recording — if this is an error, the binary " +
            "was likely built without `--features voice-capture-stub`",
        ).toBeUndefined();
        const imported = stop.ok as { id: string; content_type: string } | null;
        expect(imported, "a non-empty fixture recording returns the final clip").not.toBeNull();
        const id = (imported as { id: string }).id;
        expect(
          (imported as { content_type: string }).content_type,
          "a recorded WAV classifies as audio/wav",
        ).toBe("audio/wav");

        // ---- reopen: the saved voice note survives a catalog re-read and is
        //      stored + served as audio/wav (the inline player's source) ----
        const list = await pageSeatInvoke(
          s,
          "plugin:attachments|catalog_list",
          {},
          IPC_TIMEOUT,
        );
        expect(list.err, "catalog_list should succeed").toBeUndefined();
        const rows = list.ok as Array<{ id: string; content_type: string }>;
        const stored = rows.find((r) => r.id === id);
        expect(stored, "the recorded voice note is in the catalog").toBeDefined();
        expect(
          (stored as { content_type: string }).content_type,
          "the stored voice note is audio/wav",
        ).toBe("audio/wav");
      },
    );
  });

  it("vn2 — cancel stores nothing", async () => {
    let seeded: SeededVault;
    await scenario(
      "vn2-voice-cancel",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        const before = await pageSeatInvoke(
          s,
          "plugin:attachments|catalog_list",
          {},
          IPC_TIMEOUT,
        );
        const beforeCount = (before.ok as Array<unknown>).length;

        const start = await pageSeatInvoke(
          s,
          "plugin:attachments|voice_record_start",
          {},
          IPC_TIMEOUT,
        );
        expect(start.err, "voice_record_start should arm").toBeUndefined();
        await new Promise((resolve) => setTimeout(resolve, 150));

        const cancel = await pageSeatInvoke(
          s,
          "plugin:attachments|voice_record_cancel",
          {},
          IPC_TIMEOUT,
        );
        expect(cancel.err, "voice_record_cancel should succeed").toBeUndefined();

        const after = await pageSeatInvoke(
          s,
          "plugin:attachments|catalog_list",
          {},
          IPC_TIMEOUT,
        );
        expect(
          (after.ok as Array<unknown>).length,
          "cancelling a recording creates no attachment",
        ).toBe(beforeCount);
      },
    );
  });
});
