// Remote presence rendering + the ~100 ms plumbing ratchet (epic live-collab,
// sub-feature `collab-verification` task 2).
//
// # Reconciliation: the presence testids are `editor.*`, not `collab.*`
//
// The feature's draft `tasks.md` named `collab.remote-cursor` /
// `collab.remote-selection`, but the SHIPPED decoration roster uses the
// `editor.*` prefix (consistent with `editor.presence-row` on the presence
// roster, `src/notes/components/WhoIsHereTab.tsx`). The decoration testids
// `editor.remote-cursor` / `editor.remote-selection` were ADDED to
// `editor/src/decorations/awareness.ts` for this scenario, each carrying
// `data-participant-id`, `data-color`, `data-line` and `data-ch` (the same
// reconciliation is recorded at the top of `e2e/collab-convergence.e2e.ts`).
//
// # The producer landed; the DECORATION is still driven by a real frame payload
//
// The story is "device A edits, device B receives an awareness frame and renders
// a remote cursor/selection". The consumer half is shipped and is what this
// scenario proves, with the REAL `AwarenessPresence` payload shape. The producer
// half also exists (`collab-presence-ui` task 8, discovered), but the A-to-B
// TRANSPORT leg was NOT observed to deliver in the container: a peer-leg probe in
// `e2e/collab-convergence.e2e.ts` story 18 saw B render zero cursors while
// `collab-leak-budget` shows B RECEIVING frames and the core dropping them at the
// room match. So story 18 asserts only the SELF-ECHO DROP (the editing device
// renders no cursor for its own frame), and this file stays a RENDERER test driven
// through the host-to-UI seam, pinning the exact caret, selection and colour
// without depending on the transport's cadence.
//
// The right-panel roster testids (`editor.presence-*`) are deliberately NOT used:
// the presence tab is not reachable in this two-device fleet, and the decoration
// assertions below need no panel.
//
// # The plumbing ratchet, worded as plumbing
//
// The ~100 ms client coalescing floor (SYNC-50) is a machine PLUMBING bound and
// is asserted as one: a remote frame is applied to the peer editor within 500 ms
// on the loopback container harness. It is NOT evidence of the product's
// real-time "feel" (perceptual latency is a human manual item, never this).
//
// Vault-count precondition: 1 seeded vault on A, 1 join-bootstrapped on B.
// Self-skips without the tauri-driver harness AND the `myne-server` binary.

import { describe, expect, it } from "vitest";
import { harnessSupported, type AppSession } from "./support/session";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import { setupTwoSyncedDevices } from "./support/multi-device";
import { activeNoteId, clickNoteRow, ipcOk, pageSeatInvoke } from "./support/flows";

const driver = harnessSupported();
const server = syncServerSupported();
const ready = driver.ok && server.ok;

if (!ready) {
  // eslint-disable-next-line no-console
  console.warn(
    `[e2e] collab-presence skipped: ${!driver.ok ? driver.reason : server.reason}`,
  );
}

const describeCanary = ready ? describe : describe.skip;

// Scenario constants, the plaintext-scan needle-design rule (single
// lowercase-alnum token ≥24 chars, in-source, not a credential).
const BODY_MARKER = "presencebody7k2m9qx4w8e5rj0tt";
/** The remote peer's stable identity key (hex), as an awareness frame carries it. */
const PEER_ACTOR_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

/** The `sync://awareness` payload shape (`core/src/plugins/live/awareness.rs`,
 *  `AwarenessPresence`, camelCase across the event seam). */
interface AwarenessPayload {
  noteId: string;
  actorId: string;
  label: string | null;
  cursor: number | null;
  selection: { anchor: number; head: number } | null;
  frameType: "join" | "presence";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readBody(session: AppSession["session"], noteId: string): Promise<string> {
  return (await ipcOk(session, "plugin:notes|note_read", { noteId })) as string;
}

/** Drop a device's live co-editing session for `noteId`, best-effort. The live
 *  session is the single durable writer while open, so `note_update` is refused
 *  with `LiveSessionOpen` until it is dropped (`src/notes/liveNote.ts`). */
async function dropLiveSession(session: AppSession["session"], noteId: string): Promise<void> {
  await pageSeatInvoke(session, "plugin:live|live_session_close", { noteId }, 15_000);
}

/** 1-based line + 0-based column of `offset` in `markdown` (the editor's own
 *  document is that same markdown, so this is the value the decoration
 *  computes). */
function lineCh(markdown: string, offset: number): { line: number; ch: number } {
  const before = markdown.slice(0, offset);
  return {
    line: before.split("\n").length,
    ch: offset - (before.lastIndexOf("\n") + 1),
  };
}

describeCanary("remote presence rendering (collab-verification)", () => {
  // Story 3: a remote awareness frame renders a decoration with the right
  // `data-*`. Story 7: the plumbing ratchet, worded as plumbing, never as feel.
  // Vault-count precondition: 1 seeded vault on A, 1 join-bootstrapped on B.
  it("renders a remote cursor/selection from an awareness frame, within the plumbing bound", async () => {
    const srv = await startSyncServer();
    try {
      const devices = await setupTwoSyncedDevices(srv);
      const { a, b, noteId, teardown } = devices;
      try {
        // A writes a body with a known marker and it replicates to B, so the
        // frame's caret can land INSIDE the body (a caret inside the managed
        // frontmatter would be hidden under the properties widget, and the
        // decoration would be unobservable). The note is open in both panes, so
        // both live sessions (the single durable writer) are dropped first: A's
        // so its `note_update` is not refused, B's so its pane reloads the body
        // from DISK on the pull and the editor doc equals `note_read`, which is
        // what the frame's offsets are computed from.
        await dropLiveSession(a.session, noteId);
        await dropLiveSession(b.session, noteId);
        const base = await readBody(a.session, noteId);
        await ipcOk(a.session, "plugin:notes|note_update", {
          noteId,
          plaintext: `${base}\n${BODY_MARKER}\n`,
        });
        await ipcOk(a.session, "plugin:sync|sync_now", {});
        let replicated = false;
        for (let i = 0; i < 12 && !replicated; i++) {
          await ipcOk(b.session, "plugin:sync|sync_now", {});
          await sleep(1_500);
          replicated = (await readBody(b.session, noteId)).includes(BODY_MARKER);
        }
        expect(replicated, "the body replicated to B before the presence frame").toBe(true);

        // B must have the note OPEN as an editor tab: the store is bound to the note
        // the view holds, and the decoration is gated on it. Wait for the tab rather
        // than sampling immediately after the click (the click and the tab mount are
        // not the same tick, and a null here is what the first version flaked on).
        await clickNoteRow(b.session, noteId);
        await b.session.waitUntil(
          async () => ((await activeNoteId(b.session)) === noteId ? true : null),
          { label: `B has note ${noteId} open as a tab`, timeoutMs: 20_000 },
        );

        // The frame: a caret and a short selection inside the body marker, for a
        // peer on THIS note (the store ignores a frame for another note).
        const body = await readBody(b.session, noteId);
        const markerAt = body.indexOf(BODY_MARKER);
        const caret = markerAt >= 0 ? markerAt + 3 : Math.max(0, body.length - 1);
        const head = Math.min(caret + 4, body.length);
        const noteIdOnB = await activeNoteId(b.session);
        expect(noteIdOnB, "B has the note open (the store is bound to it)").not.toBeNull();
        const payload: AwarenessPayload = {
          noteId: noteIdOnB as string,
          actorId: PEER_ACTOR_ID,
          label: "Peer One",
          cursor: caret,
          selection: { anchor: caret, head },
          frameType: "presence",
        };

        // Drive the REAL host-to-UI seam with the REAL payload shape. See the
        // file header: the native producer is missing, so this is the only
        // honest way to exercise the renderer today.
        const startedAt = Date.now();
        await pageSeatInvoke(
          b.session,
          "plugin:event|emit",
          { event: "sync://awareness", payload },
          10_000,
        );

        // The cursor decoration, with the expected attributes.
        const cursor = await b.session.byTestId("editor.remote-cursor", { timeoutMs: 5_000 });
        // PLUMBING, not feel: the frame is APPLIED within the stated bound.
        const elapsed = Date.now() - startedAt;
        expect(elapsed, "plumbing: a remote frame applies within 500 ms").toBeLessThan(500);

        expect(await cursor.attribute("data-participant-id")).toBe(PEER_ACTOR_ID);
        const color = (await cursor.attribute("data-color")) ?? "";
        expect(color, "colour is a resolved --group-* token, never a literal").toMatch(
          /^var\(--group-[a-z]+\)$/,
        );
        const expectedCaret = lineCh(body, caret);
        expect(await cursor.attribute("data-line")).toBe(String(expectedCaret.line));
        expect(await cursor.attribute("data-ch")).toBe(String(expectedCaret.ch));

        // The selection range decoration, same discriminator + colour.
        const selection = await b.session.byTestId("editor.remote-selection", {
          timeoutMs: 5_000,
        });
        expect(await selection.attribute("data-participant-id")).toBe(PEER_ACTOR_ID);
        const selColor = (await selection.attribute("data-color")) ?? "";
        expect(selColor).toMatch(/^var\(--group-[a-z]+\)$/);
        const expectedHead = lineCh(body, head);
        expect(await selection.attribute("data-line")).toBe(String(expectedHead.line));
        expect(await selection.attribute("data-ch")).toBe(String(expectedHead.ch));
      } finally {
        await teardown();
      }
    } finally {
      await srv.teardown();
    }
  });
});
