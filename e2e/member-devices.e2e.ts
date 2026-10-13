// A member's SECOND DEVICE, end to end on the desktop client
// (myne-md/myne#852 task 11).
//
// # What no other tier can prove
//
// The join path is a composition of four things that are each unit-tested and
// that have never run together in the real app, over the real relay:
//
//   1. the phrase alone re-derives the SAME person on a second machine, so this
//      device is already a member of the vault before it has ever seen it
//      (`decisions/protocol/0604`);
//   2. the CLAIMED invite row is what it acts on, which is a row the accept's own
//      list does not render;
//   3. the owner to verify the group package against is read from the pin this
//      person's own sealed profile carries, so there is no owner-code field and no
//      name step (`decisions/protocol/0675`);
//   4. and then the payoff: this device's revisions, and the first device's, are
//      both attributed to the same member, on BOTH surfaces the durable join feeds
//      (the version history and the live presence roster).
//
// # Why the version history is the assertion rather than a member list
//
// `snapshots/` is NEVER synced (`sync-protocol.md` §9, A13/AS6: syncing the per-note
// snapshot cadence would turn each device's editing rhythm into a server-visible
// timing channel), so a second device holds no snapshot FROM the first device and
// never will. That is also not the surface this feature added.
//
// A v0.2 note is `NC05`, its history comes out of its own SYNCED Automerge change
// graph (`core/src/plugins/snapshots/commands.rs` dispatches on the note's own blob
// magic, not on the vault generation), and each revision's actor resolves through
// the same `identity_resolver` the live roster uses: device id -> bound person ->
// the roster verified against the owner's half -> that person's own signed name row
// (`decisions/protocol/0669`). So a row on THIS device naming the member is exactly
// the durable attribution working, and it is a claim about the SECOND device that no
// single-device tier can make.
//
// The scenario reads the history twice over: every revision names the member, and
// the note necessarily carries revisions from BOTH devices (the first device created
// and edited it; the second edited it after joining). `rows.length >= 2` is the
// non-vacuity belt under that, because "every row is labelled" is satisfied by a
// list of one.
//
// # The presence half, and the hop it measures
//
// The same resolver feeds the live "who is here" roster through the signed presence
// assertion a peer publishes (`decisions/protocol/0656`), reached by a different
// road: the frame's own `label` comes from the SENDER's local label
// (`live/commands.rs::set_local_label`), and this scenario deliberately sends
// `label: null`, so the frame arrives UNATTRIBUTED and the receiving device has to
// resolve it itself (`collab/presenceLabels.ts` -> `lib/identity.ts::resolveIdentity`
// -> the durable join). A row naming the member is therefore that resolution working
// on the second device, not a name the peer shipped over the wire.
//
// This is also the measurement `collab-convergence.e2e.ts` names as the next step for
// the one hop it left open. Its own words: "a direct store read (open the right
// panel's `who-is-here` tab and assert `editor.presence-row`), which separates them."
// The transport leg is asserted separately (`presenceRouted > 0` on the receiving
// device), so a failure here separates "the frame never arrived" from "it arrived and
// did not reach the store".
//
// # Fleet and preconditions
//
// Three devices plus one ephemeral server. Vault-count: 1 seeded vault on the owner
// (birth format, v0.2, so the first invite is what gains it the group tier), 0 on each
// member device. The owner is enrolled and its identity unlocked before it invites:
// the relay post needs an authenticated device.
//
// The two member devices recover the SAME phrase, which is the whole point: one
// person, two machines. `createMemberIdentity`'s approval assertion holds on the
// second call for a server-side reason rather than a client one (the recovery path is
// self-approving: `internal/auth/enroll.go`, `approved := first || path ==
// PathRecovery`), and this file asserts the two identity codes are equal, so a drift
// there fails by name rather than three steps later as a join that found nothing to
// act on. The first device's code is read BEFORE its accept, because the accept puts
// it in the editor and the identity home with it.
//
// Self-skips without the tauri-driver harness AND the `myne-server` binary, the gate
// every multi-device scenario here carries.
//
// SYNC-13: the passwords and the phrase are in-source scenario constants, and no
// `expect` below prints one or a phrase-word length.

import { describe, expect, it } from "vitest";
import { harnessSupported, type AppSession } from "./support/session";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import {
  activeNoteId,
  clickNoteRow,
  createNote,
  dismissImporterOfferIfPresent,
  pageSeatInvoke,
  runPaletteAction,
  typeIntoEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector } from "./support/webdriver";
import {
  MEMBER_NAME,
  MEMBER_PASSWORD,
  MEMBER_PHRASE,
  SYNC_BUDGET_MS,
  acceptInvite,
  createMemberIdentity,
  launchMemberDevice,
  launchOwnerDevice,
  sendInvite,
  sleep,
  startOwnerIdentity,
  syncNow,
  typePhrase,
  type Session,
} from "./support/member-fleet";

const driver = harnessSupported();
const server = syncServerSupported();
const ready = driver.ok && server.ok;

if (!ready) {
  // One honest reason line, so a filtered run explains itself.
  // eslint-disable-next-line no-console
  console.warn(
    `[e2e] member-devices skipped: ${!driver.ok ? driver.reason : server.reason}`,
  );
}

const describeCanary = ready ? describe : describe.skip;

/** What the second device's sidebar row will carry. Distinctive on purpose: the
 *  owner's seeded vault has notes of its own. */
const MEMBER_NOTE_TITLE = "Second Device Note";

/** Scenario content, not credentials (SYNC-13 permits in-source constants; these
 *  carry nothing). One body per device, so the history provably spans both. */
const FIRST_DEVICE_BODY = "written on the first device qzseconddevoneaaaaa\n";
const SECOND_DEVICE_BODY = "written on the second device qzseconddevtwobbbbb\n";

/** The `sync_awareness_stats` payload, narrowed to the fields this scenario reads.
 *
 *  `received` counts frames the TRANSPORT has handed over; `presenceRouted` and the
 *  `rx*` counters count frames the SUPERVISOR TICK has drained and routed. They move
 *  on different clocks, which is why the presence wait below polls rather than sleeps.
 *  `generation` leaves 0 on the transport's first connect. */
type AwarenessStats = {
  ok?: {
    received?: number;
    presenceRouted?: number;
    rxNoRoom?: number;
    rooms?: number;
    generation?: number;
  };
};

/** One ephemeral server and the member's two devices, with the first membership
 *  already accepted on device one. Teardown is in a `finally`, so a scenario throw
 *  never leaks a process. */
async function withMemberFleet(
  fn: (fleet: {
    owner: AppSession;
    first: AppSession;
    second: AppSession;
    /** The first device's out-of-band code, read before its accept moved it off the
     *  identity home. The second device must derive the same one. */
    firstCode: string;
  }) => Promise<void>,
): Promise<void> {
  const srv = await startSyncServer();
  let owner: AppSession | undefined;
  let first: AppSession | undefined;
  let second: AppSession | undefined;
  try {
    const launchedOwner = await launchOwnerDevice(srv.url);
    owner = launchedOwner.owner;
    first = await launchMemberDevice(1, srv.url);
    second = await launchMemberDevice(2, srv.url);

    const firstCode = await createMemberIdentity(first);
    const ownerCode = await startOwnerIdentity(owner, launchedOwner.account);
    await sendInvite(owner, firstCode);
    // The FIRST membership, and so the only path that may write a name: the member
    // signs `MEMBER_NAME` here, and that signed row is what both devices later resolve
    // their own revisions and their own presence through.
    await acceptInvite(first, ownerCode, MEMBER_NAME);

    await fn({ owner, first, second, firstCode });
  } finally {
    if (second) await second.teardown();
    if (first) await first.teardown();
    if (owner) await owner.teardown();
    await srv.teardown();
  }
}

/** A sync cycle, floored so a 100 ms poll cannot flood the backend.
 *
 *  Tolerant on purpose: the join's install is a background materialisation, so a
 *  nudge can legitimately land while the vault slot is still being written, and
 *  `syncNow`'s `ipcOk` would turn "not ready yet" into a scenario failure. */
const NUDGE_FLOOR_MS = 3_000;

function makeNudger(session: Session): () => Promise<void> {
  let last = 0;
  return async () => {
    const now = Date.now();
    if (now - last < NUDGE_FLOOR_MS) return;
    last = now;
    await pageSeatInvoke(session, "plugin:sync|sync_now", {}, 20_000);
  };
}

/** Wait until this device's sidebar offers `noteId`, then open it in a pane.
 *
 *  A member's second device MATERIALISES the vault at the join, and that is a
 *  background walk: ONE `sync_now` returning is not evidence that it finished, so
 *  the wait asks again each round rather than betting the whole 120 s budget on a
 *  single cycle landing in the right order. `clickNoteRow` re-finds inside its own
 *  poll, which matters because the list re-renders on every sync tick. */
async function openNoteOn(session: Session, noteId: string): Promise<void> {
  const nudge = makeNudger(session);
  await session.waitUntil(
    async () => {
      for (const row of await session.byTestIdAll("notes.row")) {
        if ((await row.attribute("data-note-id")) === noteId) return true;
      }
      await nudge();
      return null;
    },
    { label: `sidebar row for the member's note ${noteId}`, timeoutMs: SYNC_BUDGET_MS },
  );
  await clickNoteRow(session, noteId);
  // A pane holding a DIFFERENT note subscribes to that note's room, and the tab mount
  // is not the same tick as the row click. Both the presence read and the history read
  // below are scoped to the OPEN note.
  await session.waitUntil(
    async () => ((await activeNoteId(session)) === noteId ? true : null),
    { label: `the note ${noteId} is the active tab`, timeoutMs: 20_000 },
  );
}

/** Open the right panel's "who is here" tab. The strip renders on the editor with no
 *  separate open step (`right-panel-active-tab.e2e.ts` reads it on a fresh editor and
 *  finds `backlinks` already active), so the click IS the whole of it. */
async function openWhoIsHere(session: Session): Promise<void> {
  await session.byTestId("editor.right-panel-tabs", { timeoutMs: 20_000 });
  await (
    await session.waitForElement(
      testIdSelector("editor.right-panel-tab", { "data-panel-tab-id": "who-is-here" }),
    )
  ).click();
  await session.waitUntil(
    async () => {
      for (const tab of await session.byTestIdAll("editor.right-panel-tab")) {
        if (
          (await tab.attribute("data-panel-tab-id")) === "who-is-here" &&
          (await tab.attribute("data-active")) === "true"
        ) {
          return true;
        }
      }
      return null;
    },
    { label: "the who-is-here tab is the active right-panel tab", timeoutMs: 15_000 },
  );
}

/** Publish ONE presence frame from `session` for `noteId`.
 *
 *  `label: null` is the whole point and is also what production does: the backend
 *  command stores it verbatim (`signal.set_local_label(label)`), and the supervisor
 *  seals `sig.local_label()` into the frame, so a `None` here is what makes the frame
 *  arrive UNATTRIBUTED at the peer. The `cursor` is the caller's knob and is load
 *  bearing rather than decoration: it is what makes the frame a CHANGE the sealer
 *  will not coalesce away, so a repeat of the same value is a frame that may never
 *  be sent. */
async function publishPresence(
  session: AppSession,
  noteId: string,
  cursor: number,
): Promise<void> {
  await pageSeatInvoke(
    session.session,
    "plugin:live|live_session_set_presence",
    { noteId, cursor, selection: null, label: null },
    10_000,
  );
}

describeCanary("MD-1 a member's second device (myne-md/myne#852)", () => {
  // Vault-count precondition: 1 seeded vault on the owner, 0 on each member device.
  it("joins the same vault from the phrase alone, and both devices' revisions and presence name the member", async () => {
    await withMemberFleet(async ({ first, second, firstCode }) => {
      // ---- the revision the second device has to attribute ----
      await createNote(first.session, MEMBER_NOTE_TITLE);
      await typeIntoEditor(first.session, FIRST_DEVICE_BODY);
      await waitForSaved(first.session);
      const opened = await activeNoteId(first.session);
      expect(opened, "the member's first device has the note it just created open").toBeTruthy();
      const note = opened as string;
      // Push it before the second device exists, so the join lands on a vault that
      // already holds a member-authored revision.
      await syncNow(first.session);

      // ---- the second device, from the phrase alone ----
      //
      // One person, two machines: the same 24 words must derive the same person id and
      // the same keypair, which is what makes this device a member of a vault it has
      // never seen. Asserted rather than assumed, because the alternative is a silent
      // SECOND identity, and a second identity's invite listing is legitimately empty
      // rather than wrong, so the join below would fail three steps later with no hint
      // as to why.
      const secondCode = await createMemberIdentity(second);
      expect(
        secondCode,
        "the same phrase derives the same person on both of the member's devices",
      ).toBe(firstCode);

      // ---- the join ----
      await second.session.byTestId("identity-home.claimed-invites", { timeoutMs: SYNC_BUDGET_MS });
      await (await second.session.byTestId("identity-home.claimed-row")).click();
      await (await second.session.byTestId("identity-home.join-open")).click();
      await second.session.byTestId("identity-home.join-form");

      // The same phrase, a fresh device-local password. Neither is the owner's.
      await typePhrase(
        second.session,
        "identity-home.join-phrase",
        "identity-home.join-phrase-cell",
        MEMBER_PHRASE,
      );
      await (await second.session.byTestId("identity-home.join.password-input")).replaceText(
        MEMBER_PASSWORD,
      );
      await (await second.session.byTestId("identity-home.join.confirm-input")).replaceText(
        MEMBER_PASSWORD,
      );
      // The proof that no owner code is needed is BEHAVIOURAL and this click is it: the
      // form's own required fields are the phrase grid and the two password fields
      // (`IdentityHome.tsx`, `EnrollPhraseCredential` + `PasswordCreateForm`, whose
      // `disabled` reads only `joinPhraseCells`), so a completed submit with no code
      // field anywhere on the form is the join having verified the group package
      // against the owner PINNED in the person's own sealed profile
      // (`decisions/protocol/0675`). An absence assertion over a field that was never
      // in the markup would only be restating the source.
      await (await second.session.byTestId("identity-home.join.submit")).click();

      // The editor, and NOT a name step: this person already has a name for this vault,
      // and re-asking would let a second device silently re-name a person its first
      // device had already named. The gate's absence IS the assertion, because a join
      // that finished and then demanded a name would be a form a user could fill in and
      // this scenario would pass on the wrong behaviour.
      await second.session.byTestId("editor.settings-cta", { timeoutMs: 60_000 });
      expect(
        await second.session.byTestIdAll("name-gate.input"),
        "the join writes no display name",
      ).toHaveLength(0);

      // The first-run importer offer is an editor-mount overlay on a device that has
      // never dismissed it (its condition is `localStorage[IMPORTER_OFFER_KEY] !== "1"`
      // in THIS WebView, and this device has just mounted its editor for the first
      // time), and it registers the whole page `inert` (`useOverlayInert`). Left up, every
      // interaction below is refused as `element not interactable` while the control it
      // aims at is plainly on screen. `IfPresent` rather than the hard form because the
      // offer is conditional, and the hard form would turn "no offer this mount" into a
      // 10 s timeout. Read AFTER the name-gate assertion so that assertion is made on the
      // bare editor rather than behind an overlay.
      await dismissImporterOfferIfPresent(second.session);

      // ---- the note, on the second device ----
      await openNoteOn(second.session, note);

      // ---- the live presence roster, on the SECOND device ----
      //
      // ONE cursor for both presence steps below. It is the knob that makes each
      // published frame a CHANGE the sealer will not coalesce away, so it has to be
      // strictly increasing across the whole sequence rather than restarting per loop.
      let cursor = 0;

      // A real frame from the member's first device, which the relay fans out to the
      // room both devices subscribe to. `label: null` on purpose: it makes the frame
      // arrive UNATTRIBUTED, so the name this scenario asserts on is one the receiving
      // device resolved itself rather than one the peer shipped. `live_session_open` is
      // an idempotent attach on a note this device already has open in a pane
      // (`live_session_open_from_host` returns early), so it is safe to ask for.
      await pageSeatInvoke(first.session, "plugin:live|live_session_open", { noteId: note }, 15_000);
      await publishPresence(first, note, cursor);

      // NON-VACUITY, and the hop separator. The roster read below is satisfied by a frame
      // that never arrived, so it is paired with evidence about the leg BEFORE it: the
      // receiving device decoded an inbound frame and routed it as a presence, which
      // distinguishes "the transport and the room match both worked" from the state
      // `collab-convergence.e2e.ts` measured on an earlier revision (a frame dropped at
      // the room match).
      //
      // A BOUNDED WAIT rather than a fixed sleep, because this counter set holds two
      // clocks. `received` moves on the transport thread the instant a frame lands
      // (`AwarenessListener::push_incoming`), while `presenceRouted` and the four rejection
      // counters move only when the supervisor tick drains the inbox into
      // `drain_and_route`, roughly once a second. A read taken a fixed 3 s after the
      // publish can land in between and report `received > 0` with every routing counter
      // at 0, which is what two runs out of three at `--retry=0` produced, at 58.4 s and
      // 49.0 s. The loop below also covers the other precondition those runs showed,
      // `generation: 0`: `generation` leaves 0 only on the transport's first connect, so a
      // device that has just joined may legitimately not be connected yet when the peer
      // publishes, and a frame that arrived before this device subscribed is a frame the
      // relay never delivered to it. Hence the re-publish each round, which the cursor
      // bump is what makes work: a repeat of the same value is a frame the sealer may
      // coalesce away.
      const diag = await second.session.waitUntil(
        async () => {
          const stats = (await pageSeatInvoke(
            second.session,
            "plugin:sync|sync_awareness_stats",
            {},
            10_000,
          )) as AwarenessStats;
          if ((stats.ok?.presenceRouted ?? 0) > 0) return stats;
          cursor += 1;
          await publishPresence(first, note, cursor);
          await sleep(1_500);
          return null;
        },
        {
          label: "the member's second device routed the peer's presence frame",
          timeoutMs: 60_000,
        },
      );
      expect(
        diag.ok?.presenceRouted ?? 0,
        `the member's second device routed the peer's presence frame: ${JSON.stringify(diag)}`,
      ).toBeGreaterThan(0);

      await openWhoIsHere(second.session);
      // Wait for the RESOLVED name, not merely for a row: a row appears on the frame
      // itself and renders the degraded `unknown` copy until the label lands, so a
      // row-presence wait would read the fallback and pass on the wrong behaviour.
      //
      // The resolution is keyed on the STORE (`PaneView`'s effect runs on every
      // awareness change), and an unattributed peer is retried from scratch on each
      // one, so publishing another frame IS the retry. The cursor moves every round
      // for `publishPresence`'s stated reason. It matters here rather than in theory:
      // a frame that arrived before this device had pulled the binding store resolves
      // to nothing and stays that way until the next frame, and this device has just
      // joined.
      const presenceNames = await second.session.waitUntil(
        async () => {
          const rows = await second.session.byTestIdAll("editor.presence-row");
          if (rows.length > 0) {
            const texts = (
              await Promise.all(rows.map(async (row) => (await row.text()).trim()))
            ).filter((text) => text.length > 0);
            if (texts.some((text) => text.includes(MEMBER_NAME))) return texts;
          }
          cursor += 1;
          await publishPresence(first, note, cursor);
          await sleep(2_000);
          return null;
        },
        {
          label: "the who-is-here roster on the member's second device names the member",
          timeoutMs: 60_000,
        },
      );
      // The same member name, on the live surface, resolved through the same resolver the
      // history uses: the peer's presence assertion named a person, and that person's own
      // signed name row is what is rendered.
      expect(
        presenceNames.join(" | "),
        `the presence roster on the member's second device names the member: ${JSON.stringify(presenceNames)}`,
      ).toContain(MEMBER_NAME);

      // ---- the revision the SECOND device makes ----
      //
      // Deliberately after the presence read rather than before it: the presence frame the
      // first device published is about the note as it stood, and a concurrent edit by this
      // device would put its own caret report into the same room. The two halves are
      // sequential so neither is measuring the other's traffic.
      await typeIntoEditor(second.session, SECOND_DEVICE_BODY);
      await waitForSaved(second.session);

      // ---- the version history, read on the SECOND device ----
      //
      // Last, and never closed: the panel is `aria-modal` with a backdrop and its close
      // button carries no testid, and nothing below needs the editor.
      //
      // The presence wait above is what makes this read current rather than lucky: both
      // surfaces build their index from the same on-disk stores on EVERY call
      // (`snapshot_list_from_host` and `resolve_identity_from_host` each call
      // `durable_attribution_in_dir`), so a device whose live roster already names the
      // member is a device whose history resolver has the same three stores to read.
      await runPaletteAction(second.session, "snapshots.open", "snap");
      await second.session.byTestId("snapshots.panel");
      const rows = await second.session.byTestIdAll("snapshots.row");
      // Two machines edited this note, so a single row could not cover both. This is the
      // belt under "every row is labelled", which a list of one would satisfy.
      expect(
        rows.length,
        "the history holds a revision from each of the member's two devices",
      ).toBeGreaterThanOrEqual(2);

      // One author cell per row, read through the panel rather than through a captured
      // row handle: the list re-renders on selection and on a reload, and a handle taken
      // before that cannot be re-found.
      const authors = await second.session.byTestIdAll("snapshots.author");
      expect(
        authors.length,
        "every history row carries an author cell",
      ).toBe(rows.length);
      const labels = await Promise.all(
        authors.map(async (cell) => ({
          text: (await cell.text()).trim(),
          kind: await cell.attribute("data-author-kind"),
        })),
      );
      // Every revision names the member, whichever machine made it. A revision from the
      // first device resolving here is the durable binding for THAT device, and one from
      // the second device is the binding the join just wrote; the two together are what
      // "the same member" means.
      expect(
        labels.map((l) => l.text),
        `every revision on the member's second device names the member: ${JSON.stringify(labels)}`,
      ).toEqual(rows.map(() => MEMBER_NAME));
      // And none of them fell through to the degraded device-code form, which is what a
      // missing binding renders. The label is a label rather than a proof of authorship
      // (`decisions/protocol/0660`), but a row that cannot even reach a name is a different
      // failure, and it is one the belt above cannot see.
      expect(
        labels.filter((l) => l.kind !== "Person").map((l) => l.kind),
        "no revision resolved to a bare device or to unknown",
      ).toEqual([]);
    });
  });
});
