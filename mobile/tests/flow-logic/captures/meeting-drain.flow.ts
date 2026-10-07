// Flow-logic: the Apple Watch pending-MEETING drain (myne-md/myne#812, task 3).
// Drives headless Chromium against the dev server with mock IPC — NOT an
// end-to-end suite. The native watch capture, the WatchConnectivity file
// transfer and the device-key seal are the manual device-E2E exemption
// (`mobile/docs/dev/device-matrix.md`); what IS JS-testable is the slice inside
// the WebView trust boundary:
//
//   • on unlock (EditorFlow mount), `drain_pending_meetings` → transcribe each
//     chunk's attachment → `note_create` once per session → `ack_meeting_session`
//     per session (drainPendingMeetings);
//   • an incomplete session still yields a note and reports the gap;
//   • a crash between note-create and ack re-drains into a duplicate (the
//     at-least-once discipline).
//
// The Rust decrypt→import is covered by `cargo test -p myne-core captures::` and
// the `MYF1` byte layout by `cargo test -p protocol` + the share-import vectors;
// here we pin only the JS orchestration.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** The note bodies the drain created that look like a meeting note (the dev
 *  seeder may create unrelated notes under `vite dev`, so filter rather than
 *  assert the whole list). */
async function meetingNotes(page: Page): Promise<string[]> {
  const all = await page.evaluate(
    () => (window as unknown as { __noteCreates?: string[] }).__noteCreates ?? [],
  );
  return all.filter((t) => t.includes("## Transcript"));
}

async function readMeetingAcks(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __meetingAcks?: string[] }).__meetingAcks ?? [],
  );
}

/** The meeting-note bodies the drain UPDATED (the append path), filtered the
 *  same way as {@link meetingNotes}. */
async function meetingNoteUpdates(page: Page): Promise<string[]> {
  const all = await page.evaluate(
    () => (window as unknown as { __noteUpdates?: string[] }).__noteUpdates ?? [],
  );
  return all.filter((t) => t.includes("## Transcript"));
}

async function readSealInboxCalls(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __sealMeetingInboxCalls?: number }).__sealMeetingInboxCalls ?? 0,
  );
}

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

/** A three-chunk session, chunk indices 0/1/2 with distinct attachment ids. */
function threeChunkSession() {
  return {
    session_id: "sess-a",
    started_at: 1_700_000_000_000,
    chunks: [
      { chunk_index: 0, attachment_id: A },
      { chunk_index: 1, attachment_id: B },
      { chunk_index: 2, attachment_id: C },
    ],
    missing_chunk_indices: [] as number[],
    retryable_chunk_indices: [] as number[],
  };
}

/** The session ids whose ENTIRE chunk set resolved (mirror of the Rust ack,
 *  where the manifest row survives while any entry is still on disk). */
async function readMeetingAcked(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __meetingAcked?: string[] }).__meetingAcked ?? [],
  );
}

/** The resolved chunk indices the drain sent for a session. */
async function readMeetingResolved(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(
    () =>
      (window as unknown as { __meetingResolved?: Record<string, number[]> })
        .__meetingResolved ?? {},
  );
}

const HEADER = "## Transcript\n\n_This is a machine transcript of the meeting and may contain errors._\n\n";

const TITLE_RE = /^---\ntitle: Meeting \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n---\n\n/;

test.describe("Apple Watch pending-meeting drain", () => {
  test("one drain pass creates exactly one note with the audio embeds in order, then acks", async ({
    page,
  }) => {
    // Default boot is an Unlocked slot → the app routes straight to the editor,
    // so EditorFlow mounts and the drain runs immediately.
    await installMockIpc(page, { pendingMeetings: [threeChunkSession()] });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();

    // Exactly one meeting note was created, carrying a date title, the three
    // embeds in chunk order, and the transcript.
    await expect.poll(() => meetingNotes(page)).toHaveLength(1);
    const body = (await meetingNotes(page))[0];
    expect(TITLE_RE.test(body)).toBe(true);
    const rest = body.replace(TITLE_RE, "");
    expect(rest).toBe(
      `![[att:${A}]]\n\n![[att:${B}]]\n\n![[att:${C}]]\n\n${HEADER}` +
        "the quick brown fox\n\nthe quick brown fox\n\nthe quick brown fox",
    );

    // The session was acked exactly once (only a drain that created a note acks).
    await expect.poll(() => readMeetingAcks(page)).toEqual(["sess-a"]);
  });

  test("an incomplete session still yields a note and reports the gap", async ({ page }) => {
    // Chunks 0 and 2 arrived; chunk 1 never did. The note keeps what arrived and
    // the gap is surfaced as a toast.
    await installMockIpc(page, {
      pendingMeetings: [
        {
          session_id: "sess-gap",
          started_at: 1_700_000_000_000,
          chunks: [
            { chunk_index: 0, attachment_id: A },
            { chunk_index: 2, attachment_id: C },
          ],
          missing_chunk_indices: [1],
          retryable_chunk_indices: [],
        },
      ],
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();

    await expect.poll(() => meetingNotes(page)).toHaveLength(1);
    const body = (await meetingNotes(page))[0];
    expect(TITLE_RE.test(body)).toBe(true);
    expect(body.replace(TITLE_RE, "")).toBe(
      `![[att:${A}]]\n\n![[att:${C}]]\n\n${HEADER}` +
        "the quick brown fox\n\nthe quick brown fox",
    );
    await expect.poll(() => readMeetingAcks(page)).toEqual(["sess-gap"]);

    // The gap is reported (the note is not silent about the missing chunk).
    await expect(page.getByTestId("toast.host")).toContainText("gap");
  });

  test("a crash after note-create and before ack re-drains by APPENDING, not duplicating", async ({
    page,
  }) => {
    await installMockIpc(page, {
      pendingMeetings: [threeChunkSession()],
      // The first ack rejects: the note is written, the ack fails, and the
      // session stays in the manifest.
      meetingAckFailures: 1,
      // Persist the note body so the re-drain can READ the existing note and
      // append to it.
      statefulNoteWrites: true,
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();

    // The note was created, but the ack failed.
    await expect.poll(() => meetingNotes(page)).toHaveLength(1);
    await expect.poll(() => readMeetingAcks(page)).toEqual(["sess-a"]);

    // A second drain (foreground) sees the un-acked session again. The note id
    // was recorded before the failed ack, so the re-drain APPENDS to that note
    // instead of creating a second, fragmenting one (myne-md/myne#812 review).
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => readMeetingAcks(page)).toEqual(["sess-a", "sess-a"]);
    expect(await meetingNotes(page)).toHaveLength(1); // still exactly ONE note
  });

  test("a late chunk re-drains into the session's existing note, not a second one", async ({
    page,
  }) => {
    // The exact fragmentation case: a first drain wrote the note from chunk 0,
    // chunk 1 failed transiently and resolves on a later unlock. The session
    // carries the note id it already produced, so the late chunk is APPENDED.
    const existing = `![[att:${A}]]\n\n${HEADER}first words`;
    await installMockIpc(page, {
      pendingMeetings: [
        {
          session_id: "sess-late",
          started_at: 1_700_000_000_000,
          chunks: [{ chunk_index: 1, attachment_id: B }],
          missing_chunk_indices: [],
          retryable_chunk_indices: [],
          note_id: "existing-note",
        },
      ],
      noteBodies: { "existing-note": existing },
      statefulNoteWrites: true,
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();

    // No NEW note was created; the existing one was updated.
    await expect.poll(() => readMeetingAcks(page)).toEqual(["sess-late"]);
    expect(await meetingNotes(page)).toHaveLength(0);
    const updated = await meetingNoteUpdates(page);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toContain(`![[att:${A}]]`); // kept the existing embed
    expect(updated[0]).toContain(`![[att:${B}]]`); // added the late chunk's embed
    expect(updated[0]).toContain("the quick brown fox"); // the late transcript
    // The embed is in the embed block, above the transcript heading.
    expect(updated[0].lastIndexOf("![[att:")).toBeLessThan(
      updated[0].indexOf("## Transcript"),
    );
  });

  test("unlock re-scans the meeting inbox (the retry half of the seal)", async ({ page }) => {
    // A chunk whose on-arrival seal failed stays in the app-owned inbox under its
    // metadata-bearing name; the drain re-scans it on unlock (myne-md/myne#812
    // review). The boot path also calls it; here we only assert it runs.
    await installMockIpc(page, { pendingMeetings: [] });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
    await expect.poll(() => readSealInboxCalls(page)).toBeGreaterThan(0);
  });

  test("a retryable chunk is not acked away (no permanent audio loss)", async ({ page }) => {
    // **The H3 regression.** Chunks 0 and 2 imported; chunk 1 failed to import
    // TRANSIENTLY (no space, a momentary IO error). The drain must send only the
    // RESOLVED indices to `ack_meeting_session`, so chunk 1's sealed entry and its
    // manifest row survive and the session re-drains next unlock. Acking the
    // whole session would delete audio that was merely delayed.
    await installMockIpc(page, {
      pendingMeetings: [
        {
          session_id: "sess-retry",
          started_at: 1_700_000_000_000,
          chunks: [
            { chunk_index: 0, attachment_id: A },
            { chunk_index: 2, attachment_id: C },
          ],
          missing_chunk_indices: [],
          retryable_chunk_indices: [1],
        },
      ],
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();

    // The note is still written from what arrived.
    await expect.poll(() => meetingNotes(page)).toHaveLength(1);

    // The ack carried ONLY the resolved indices: 1 is absent, so the Rust side
    // keeps its entry + manifest row.
    await expect.poll(() => readMeetingAcks(page), { timeout: 8000 }).toEqual(["sess-retry"]);
    expect(await readMeetingResolved(page)).toEqual({ "sess-retry": [0, 2] });

    // And the whole session is NOT marked fully acked, because chunk 1 is still
    // queued on the phone.
    expect(await readMeetingAcked(page)).not.toContain("sess-retry");
  });

  test("no pending meetings → no notes created, no acks", async ({ page }) => {
    await installMockIpc(page, { pendingMeetings: [] });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
    await page.waitForTimeout(150);
    expect(await readMeetingAcks(page)).toHaveLength(0);
  });

  test("a native meeting-chunk event seals the arrival with its manifest fields", async ({ page }) => {
    // The receiver (`WCMeetingReceiver`) dispatches this event for each
    // WatchConnectivity `transferFile` delivery; the app must seal it on arrival
    // (device-key based), carrying the path + manifest fields intact.
    await installMockIpc(page, { pendingMeetings: [] });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();

    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("myne-meeting-chunk", {
          detail: {
            path: "/var/mobile/…/inbox/chunk-1",
            sessionId: "sess-native",
            chunkIndex: 1,
            startedAt: 1_700_000_000_000,
          },
        }),
      ),
    );

    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __meetingChunkSeals?: unknown[] }).__meetingChunkSeals ?? [],
        ),
      )
      .toEqual([
        {
          sessionId: "sess-native",
          chunkIndex: 1,
          startedAt: 1_700_000_000_000,
          path: "/var/mobile/…/inbox/chunk-1",
        },
      ]);
  });
});
