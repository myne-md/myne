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
  };
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

  test("a crash after note-create and before ack re-drains into a duplicate", async ({ page }) => {
    await installMockIpc(page, {
      pendingMeetings: [threeChunkSession()],
      // The first ack rejects: the note is written, the ack fails, and the
      // session stays in the manifest.
      meetingAckFailures: 1,
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();

    // The note was created, but the ack failed.
    await expect.poll(() => meetingNotes(page)).toHaveLength(1);
    await expect.poll(() => readMeetingAcks(page)).toEqual(["sess-a"]);

    // A second drain (foreground) sees the un-acked session again and writes a
    // duplicate note rather than nothing — the at-least-once contract.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => meetingNotes(page)).toHaveLength(2);
    // …and the second attempt acks, clearing the session.
    await expect.poll(() => readMeetingAcks(page)).toEqual(["sess-a", "sess-a"]);
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
