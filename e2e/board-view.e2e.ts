// Board view E2E (board-view, myne-md/myne#922).
//
// Four stories, four boots. Each one is a different promise, so merging them
// would make one red read as three.
//
//   bv1  A board renders the lane ORDER the view declares, keeps a declared lane
//        that no note carries, and appends a value the declaration does not name.
//        This is the shape the surface exists for: the board is a projection over
//        `group_by`, so an empty column is normal and a new status cannot hide
//        the cards that carry it.
//   bv2  A drag writes ONE property on ONE note, and the note's bytes differ in
//        exactly that key. The assertion is on the note, not on the board,
//        because the failure this design prevents is a silent disagreement
//        between the two.
//   bv3  A drag the host must refuse puts the card back and leaves the note
//        byte-identical to what another writer left there. The card never shows
//        a lane the note does not carry.
//   bv4  Adding a card writes the lane value into the new note, a lane rename
//        moves every card in it and rewrites the declaration, and ONE restore
//        puts the notes and the declared order back.
//
// One thing this file deliberately does NOT prove, said here rather than left to
// be inferred: that `view_approvals` is device-local for the sync merge. A
// single device and a single vault cannot observe a merge classification at all,
// and the Rust test over the classification table is where that lives
// (`view_approvals_are_device_local_and_never_arrive_by_sync`).
//
// The view is composed through the two production commands that own it
// (`plugin:prefs|upsert_saved_view` and `plugin:prefs|set_view_approval`) rather
// than through the settings modal, for one concrete reason: the form has no
// editor for `lanes`, and the declared order is the subject of bv1. Everything
// past that composition is the real flow: the real query engine groups the real
// notes, and every write goes through `plugin:notes|note_set_field`, the same
// single-note command a table edit uses.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickRibbonUntilVisible,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  pageSeatInvoke,
  setViewsEnabled,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Element, type Session } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;

/** W3C element-reference key. The harness keeps its own copy private
 *  (`support/webdriver.ts`), and a pointer action needs it to name an element as
 *  an origin, so this file carries the constant rather than re-exporting it. */
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

/** The one view id every scenario uses, chosen rather than random so a failure
 *  names the same thing in the app, the prefs blob and this file. Distinct from
 *  the id `view-manifests.e2e.ts` uses so the two files cannot be confused in a
 *  shared artefact. */
const VIEW_ID = "e2e-board";

/** Notes are seeded through real IPC (frontmatter typed into the Live editor is
 *  cursor-fragile) and the WebView then reloads so the note cache and the
 *  property index see them. The `saved-views-table-list.e2e.ts` precedent.
 *  Returns the ids in the order given. */
async function seedFrontmatterNotes(
  s: Session,
  plaintexts: readonly string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const plaintext of plaintexts) {
    const r = await pageSeatInvoke(
      s,
      "plugin:notes|note_create",
      { plaintext },
      IPC_TIMEOUT,
    );
    expect(r.err, "note_create should succeed").toBeUndefined();
    ids.push(String(r.ok));
  }
  await s.refresh();
  await s.byTestId("editor.root", { timeoutMs: 30_000 });
  await dismissImporterOfferIfPresent(s);
  return ids;
}

/**
 * Compose the board definition and approve it on this device.
 *
 * Both halves are production IPC. The approval is what lets the board run at
 * all, and it is written for the version being stored, which is the same
 * equality the host checks on every field write.
 */
async function seedBoardView(
  s: Session,
  lanes: readonly string[],
): Promise<void> {
  const view = {
    columns: ["status"],
    filters: { kind: "all" },
    group_by: "status",
    id: VIEW_ID,
    lanes: [...lanes],
    name: "Release board",
    version: 1,
    view_type: "board",
    write_fields: ["status"],
  };
  const stored = await pageSeatInvoke(
    s,
    "plugin:prefs|upsert_saved_view",
    { view },
    IPC_TIMEOUT,
  );
  expect(stored.err, "the view definition is stored").toBeUndefined();
  const approved = await pageSeatInvoke(
    s,
    "plugin:prefs|set_view_approval",
    { viewId: VIEW_ID, version: 1, definition: null },
    IPC_TIMEOUT,
  );
  expect(approved.err, "this device approves the definition it composed")
    .toBeUndefined();
}

/** Open the board from the sidebar flyout, which is the user's own door. */
async function openBoard(s: Session): Promise<void> {
  await clickRibbonUntilVisible(s, "views.show", "views.flyout");
  await (await s.byTestId("views.row")).click();
  await s.byTestId("editor.view-host", { timeoutMs: 30_000 });
  await s.byTestId("view.board", { timeoutMs: 30_000 });
}

/** The lane VALUES in rendered order, left to right. Read from the lane
 *  elements' own `data-lane-value`, so the answer is the order the DOM has
 *  rather than the order the test expected. */
async function laneValues(s: Session): Promise<string[]> {
  const lanes = await s.byTestIdAll("view.lane");
  const values: string[] = [];
  for (const lane of lanes) {
    values.push((await lane.attribute("data-lane-value")) ?? "");
  }
  return values;
}

/** A selector for one lane by its value, built from the same testid idiom as
 *  every other lookup (a descendant testid chain, never a class or a text
 *  selector). */
function laneSelector(lane: string): string {
  return testIdSelector("view.lane", { "data-lane-value": lane });
}

/** Wait until `noteId`'s card is (or is not) inside `lane`. The success
 *  condition is IN the predicate, so a wait that never resolves is a failure
 *  rather than a stale read. */
async function expectCardInLane(
  s: Session,
  lane: string,
  noteId: string,
  present = true,
): Promise<void> {
  await s.waitUntil(
    async () => {
      const found = await s.findElements(
        laneSelector(lane) +
          " " +
          testIdSelector("view.card-slot", { "data-note-id": noteId }),
      );
      return (found.length > 0) === present ? true : null;
    },
    { label: `card ${noteId} ${present ? "in" : "outside"} lane "${lane}"` },
  );
}

/** The note's plaintext as the host reads it. The board's own report is never
 *  the evidence: the claim under test is about the FILE, and a rendered card is
 *  a projection of data the app already had. */
async function noteBytes(s: Session, noteId: string): Promise<string> {
  const r = await pageSeatInvoke(
    s,
    "plugin:notes|note_read",
    { noteId },
    IPC_TIMEOUT,
  );
  expect(r.err, "note_read should succeed").toBeUndefined();
  return String(r.ok);
}

/** The refusal line the board renders after a dropped gesture the host refused,
 *  or `null` while there is none. Re-found on every read because the board
 *  re-renders when the optimism ends. */
async function refusalText(s: Session): Promise<string | null> {
  const lines = await s.findElements(testIdSelector("view.board-refusal"));
  if (lines.length === 0) return null;
  return await lines[0]!.textContent();
}

/** Why the board says it cannot place a card, when an add failed. */
async function addErrorText(s: Session): Promise<string | null> {
  const lines = await s.findElements(testIdSelector("view.board-add-error"));
  if (lines.length === 0) return null;
  return await lines[0]!.textContent();
}

function atElement(element: Element, x = 0, y = 0): Record<string, unknown> {
  return {
    type: "pointerMove",
    duration: 0,
    origin: { [ELEMENT_KEY]: element.elementId },
    x,
    y,
  };
}

/**
 * Drag a card onto a lane with the pointer, as a user does.
 *
 * ONE W3C Actions sequence rather than several calls. The harness's working
 * pointer helpers (`actionClick`, `modifierClick`) are single sequences for the
 * same reason: state carried across separate `/actions` calls is not a property
 * this driver documents, and a gesture that relies on it fails in a way that
 * looks like a product defect. The pauses are the frames a real gesture spans:
 * a press becomes a drag only once the pointer has travelled past the board's
 * threshold, and the drop target is only accepted once it is a drag, so the
 * events must not land in one synchronous batch.
 */
async function dragCardToLane(
  s: Session,
  card: Element,
  lane: Element,
): Promise<void> {
  await s.send("POST", "/actions", {
    actions: [
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          atElement(card),
          { type: "pause", duration: 60 },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 60 },
          atElement(lane),
          { type: "pause", duration: 60 },
          atElement(lane, -12, 12),
          { type: "pause", duration: 60 },
          { type: "pointerUp", button: 0 },
          { type: "pause", duration: 60 },
        ],
      },
    ],
  });
}

/** The one card slot inside `lane`, which is what a drag is performed on. */
async function cardSlotInLane(
  s: Session,
  lane: string,
  noteId: string,
): Promise<Element> {
  return await s.waitForElement(
    laneSelector(lane) +
      " " +
      testIdSelector("view.card-slot", { "data-note-id": noteId }),
  );
}

/** Where every card currently is, as `lane:noteId` pairs, for a failure message
 *  that names the board's state instead of a timeout. */
async function cardMap(s: Session): Promise<string[]> {
  const pairs: string[] = [];
  for (const lane of await s.byTestIdAll("view.lane")) {
    const value = (await lane.attribute("data-lane-value")) ?? "";
    const cards = await s.findElements(
      laneSelector(value) + " " + testIdSelector("view.card-slot"),
    );
    for (const card of cards) {
      pairs.push(`${value}:${await card.attribute("data-note-id")}`);
    }
  }
  return pairs;
}

describeE2E("bv1 a board renders its declared lane order and keeps an empty lane (myne-md/myne#922)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("orders lanes by the declaration, renders a lane nothing carries, and appends a value it does not name", async () => {
    let password = "";
    await scenario(
      "bv1-declared-order-empty-lane",
      {
        seed: (dir) => void (password = seedVault(dir).password),
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await setViewsEnabled(s, true);

        // "Blocked" is deliberately NOT declared: it is the value a user adds to
        // their own process after the view was authored, and the board must show
        // its cards rather than hide them. "Done" is declared and empty.
        const [alpha, beta, gamma] = await seedFrontmatterNotes(s, [
          "---\ntitle: Alpha\nowner: me\nstatus: Backlog\n---\nbody alpha",
          "---\ntitle: Beta\nowner: me\nstatus: Doing\n---\nbody beta",
          "---\ntitle: Gamma\nowner: me\nstatus: Blocked\n---\nbody gamma",
        ]);
        await seedBoardView(s, ["Backlog", "Doing", "Done"]);
        await openBoard(s);

        // Declared order first (including the empty lane in its declared place),
        // then the undeclared value, appended rather than dropped.
        await s.waitUntil(
          async () => {
            const values = await laneValues(s);
            return values.join("|") === "Backlog|Doing|Done|Blocked"
              ? true
              : null;
          },
          { label: "lanes in declared order, then the undeclared value" },
        );

        // The empty lane is a real lane with its own stated state, not a gap.
        const emptyLanes = await s.findElements(
          laneSelector("Done") + " " + testIdSelector("view.lane-empty"),
        );
        expect(emptyLanes.length, "the empty declared lane renders its state")
          .toBe(1);

        // Every note is on the board, in the lane its own property names.
        await expectCardInLane(s, "Backlog", alpha);
        await expectCardInLane(s, "Doing", beta);
        await expectCardInLane(s, "Blocked", gamma);
      },
    );
  });
});

describeE2E("bv2 a drag writes one property on one note (myne-md/myne#922)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("moves the card and changes exactly the lane key in the note's bytes", async () => {
    let password = "";
    await scenario(
      "bv2-drag-one-field",
      {
        seed: (dir) => void (password = seedVault(dir).password),
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await setViewsEnabled(s, true);

        const [alpha] = await seedFrontmatterNotes(s, [
          "---\ntitle: Alpha\nowner: me\nstatus: Doing\n---\nbody alpha",
        ]);
        await seedBoardView(s, ["Doing", "Done"]);
        await openBoard(s);
        // The gesture is only offered where the view declares its lane property
        // writable, so this line separates "the board refused to offer a drag"
        // from "the drag did nothing" when the assertion below fails.
        await s.byTestId("view.board-bulk-bar");
        await expectCardInLane(s, "Doing", alpha);

        const before = await noteBytes(s, alpha);
        expect(before, "the seeded note carries its lane value").toContain(
          "status: Doing",
        );

        await dragCardToLane(
          s,
          await cardSlotInLane(s, "Doing", alpha),
          await s.waitForElement(laneSelector("Done")),
        );

        // Wait for the HOST's answer, not for the board's optimism: a drop is
        // placed optimistically the moment the pointer is released, and a
        // refused one is put back when the command settles, so the rendered lane
        // is briefly not the note's. The note is the authority this scenario is
        // about, and starting the wait from its bytes is what keeps the read
        // below from sampling the gap between the two.
        const settled = await s.waitUntil(
          async () => {
            const bytes = await noteBytes(s, alpha);
            if (bytes.includes("status: Done")) return { moved: bytes };
            const refusal = await refusalText(s);
            if (refusal !== null) return { refused: refusal };
            return null;
          },
          { label: "the drop settles into a note that carries the new lane" },
        );
        if ("refused" in settled) {
          throw new Error(
            `the drag was refused by the host: ${settled.refused}\nnote bytes:\n${await noteBytes(s, alpha)}`,
          );
        }

        // The card lands where the DATA says: the write went through the host,
        // the index was refreshed and the view re-ran.
        await expectCardInLane(s, "Done", alpha);
        await expectCardInLane(s, "Doing", alpha, false);

        // THE BYTES. One key differs and the rest of the note is byte-identical,
        // which is the property that makes a drag mergeable and undoable.
        const after = settled.moved;
        expect(
          after,
          `the note differs in exactly the lane key\nbefore:\n${before}after:\n${after}`,
        ).toBe(before.replace("status: Doing", "status: Done"));
        expect(after, "the body is untouched").toContain("body alpha");
        expect(after, "the card's other property is untouched").toContain(
          "owner: me",
        );
      },
    );
  });
});

describeE2E("bv3 a refused drag puts the card back and leaves the note alone (myne-md/myne#922)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("reports why, returns the card to its lane, and does not overwrite the value another writer set", async () => {
    let password = "";
    await scenario(
      "bv3-refused-drag",
      {
        seed: (dir) => void (password = seedVault(dir).password),
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await setViewsEnabled(s, true);

        const [alpha] = await seedFrontmatterNotes(s, [
          "---\ntitle: Alpha\nowner: me\nstatus: Doing\n---\nbody alpha",
        ]);
        await seedBoardView(s, ["Doing", "Done"]);
        await openBoard(s);
        await s.byTestId("view.board-bulk-bar");
        await expectCardInLane(s, "Doing", alpha);

        // Another writer changes the same field underneath the board. This goes
        // through the production command directly rather than through its TS
        // wrapper on purpose: the wrapper re-indexes and announces, which would
        // refresh the board, and the case under test is the one where the board's
        // rendered lane is stale. Same shape as the bulk scenario's drift.
        const drifted = await pageSeatInvoke(
          s,
          "plugin:notes|note_set_field",
          {
            noteId: alpha,
            viewId: VIEW_ID,
            field: "status",
            expectedValue: "Doing",
            newValue: "Backlog",
          },
          IPC_TIMEOUT,
        );
        expect(drifted.err, "the concurrent write lands").toBeUndefined();
        const driftedBytes = await noteBytes(s, alpha);
        expect(driftedBytes, "the other writer's value is on disk").toContain(
          "status: Backlog",
        );

        // The drop asks for Doing -> Done, and the precondition no longer holds.
        await dragCardToLane(
          s,
          await cardSlotInLane(s, "Doing", alpha),
          await s.waitForElement(laneSelector("Done")),
        );

        // One line, where the gesture happened, naming the host's own reason and
        // the lane the card went back to. The wait fails with the note's actual
        // bytes when the write LANDED instead, so a broken precondition reads as
        // "the drag succeeded" rather than as a missing banner.
        try {
          await s.waitUntil(
            async () => {
              const text = await refusalText(s);
              if (text === null) {
                const bytes = await noteBytes(s, alpha);
                if (!bytes.includes("status: Backlog")) {
                  throw new Error(
                    `the refused drag WROTE the note:\n${bytes}\nexpected:\n${driftedBytes}`,
                  );
                }
                return null;
              }
              return text.includes("changed somewhere else") &&
                text.includes("Doing")
                ? true
                : null;
            },
            { label: "the refusal names the reason and the lane it returned to" },
          );
        } catch (cause) {
          throw new Error(
            `no refusal line naming the reason. lanes=${JSON.stringify(await laneValues(s))} ` +
              `cards=${JSON.stringify(await cardMap(s))} ` +
              `refusal=${JSON.stringify(await refusalText(s))} ` +
              `addError=${JSON.stringify(await addErrorText(s))}\n` +
              `note bytes:\n${await noteBytes(s, alpha)}\n${(cause as Error).message}`,
          );
        }

        // The card is back where it was and nowhere else.
        await expectCardInLane(s, "Doing", alpha);
        await expectCardInLane(s, "Done", alpha, false);

        // The note is byte-identical to what the other writer left: the refusal
        // wrote nothing, so it cannot have reverted somebody else's change.
        expect(await noteBytes(s, alpha), "the refused drag wrote nothing").toBe(
          driftedBytes,
        );
      },
    );
  });
});

describeE2E("bv4 add a card, rename its lane, and restore the whole action once (myne-md/myne#922)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("writes the lane value into a new note, moves a lane's cards on rename, and puts both back with one restore", async () => {
    let password = "";
    await scenario(
      "bv4-add-rename-restore",
      {
        // **v0.1 on purpose.** A note in the current on-disk format is a CRDT
        // note whose change graph is its own history, so a field write captures
        // no snapshot and the restore is not offered at all. The restore this
        // scenario exists for needs a note the host snapshots.
        seed: (dir) =>
          void (password = seedVault(dir, { generation: "v0.1" }).password),
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await setViewsEnabled(s, true);

        const [alpha] = await seedFrontmatterNotes(s, [
          "---\ntitle: Alpha\nowner: me\nstatus: Doing\n---\nbody alpha",
        ]);
        await seedBoardView(s, ["Doing", "Done"]);
        await openBoard(s);
        await expectCardInLane(s, "Doing", alpha);
        const beforeRename = await noteBytes(s, alpha);

        // ---- add a card into a lane -----------------------------------------
        const cardsBefore = (
          await s.findElements(
            laneSelector("Doing") + " " + testIdSelector("view.card-slot"),
          )
        ).length;
        await (
          await s.waitForElement(
            laneSelector("Doing") + " " + testIdSelector("view.board-add-card"),
          )
        ).click();

        // The created note opens in its own tab, which takes the board off
        // screen, so the note's editor appearing is the signal that the gesture
        // ran to the end. Come back to the board through the flyout afterwards,
        // the same door a user uses.
        await s.byTestId("editor.content", { timeoutMs: 30_000 });
        await openBoard(s);

        // The new card appears only once the field write has landed, so waiting
        // for the count to move is waiting for the write rather than for a
        // painted placeholder. A refusal inside the gesture has its own line, so
        // this wait reports the reason instead of timing out on it.
        let newCardId: string;
        try {
          newCardId = await s.waitUntil(
            async () => {
              const cards = await s.findElements(
                laneSelector("Doing") + " " + testIdSelector("view.card-slot"),
              );
              if (cards.length === cardsBefore + 1) {
                for (const card of cards) {
                  const id = await card.attribute("data-note-id");
                  if (id !== null && id !== alpha) return id;
                }
              }
              const failure = await addErrorText(s);
              if (failure !== null) {
                throw new Error(
                  `the board refused to place the new card: ${failure}`,
                );
              }
              return null;
            },
            { label: "the added card lands in the lane it was added to" },
          );
        } catch (cause) {
          const listed = await pageSeatInvoke(
            s,
            "plugin:notes|note_list",
            {},
            IPC_TIMEOUT,
          );
          const ids = Array.isArray(listed.ok) ? (listed.ok as string[]) : [];
          const created = ids.filter((id) => id !== alpha);
          const createdText =
            created.length === 0
              ? "no note was created at all"
              : JSON.stringify(
                  await Promise.all(
                    created.map(async (id) => ({ id, text: await noteBytes(s, id) })),
                  ),
                );
          throw new Error(
            `the added card is not in its lane. lanes=${JSON.stringify(await laneValues(s))} ` +
              `cards=${JSON.stringify(await cardMap(s))} ` +
              `addError=${JSON.stringify(await addErrorText(s))} ` +
              `created=${createdText}\n` +
              `${(cause as Error).message}`,
          );
        }
        expect(
          await noteBytes(s, newCardId),
          "the created note carries the lane value",
        ).toContain("status: Doing");

        // ---- rename the lane -------------------------------------------------
        await (
          await s.waitForElement(
            laneSelector("Doing") + " " + testIdSelector("view.board-rename"),
          )
        ).click();
        const input = await s.byTestId("view.board-rename-input");
        await input.replaceText("In progress");
        await (await s.byTestId("view.board-rename-save")).click();

        // The cards moved AND the declaration moved: the lane now reads by its
        // new name, which can only come from the updated `lanes`.
        await s.waitUntil(
          async () => ((await laneValues(s)).includes("In progress") ? true : null),
          { label: "the renamed lane renders under its new value" },
        );
        await expectCardInLane(s, "In progress", alpha);
        const renamedBytes = await noteBytes(s, alpha);
        expect(renamedBytes, "the rename wrote the new value").toContain(
          "In progress",
        );
        expect(renamedBytes, "the old value is gone").not.toContain(
          "status: Doing",
        );

        // ---- ONE restore -----------------------------------------------------
        await (await s.byTestId("view.board-restore")).click();
        await s.byTestId("view.board-restored", { timeoutMs: 30_000 });
        // The definition half is its own statement, because a restore that put the
        // notes back and left the lane renamed would be half an action.
        await s.byTestId("view.board-lane-order-restored", { timeoutMs: 30_000 });

        // THE BYTES, not the absence of an error: the note is exactly what it was
        // before the action.
        expect(await noteBytes(s, alpha), "the note is byte-identical again").toBe(
          beforeRename,
        );

        // The declaration came back too. Declared lanes always render first, in
        // their declared order, so the leading lanes ARE the declaration: a
        // restore that put the notes back and left the lane renamed reads
        // "In progress" here. A data lane beyond them is not this assertion's
        // business (a note the action could not put back keeps its own value, and
        // the report says which one).
        try {
          await s.waitUntil(
            async () => {
              const values = await laneValues(s);
              return values.slice(0, 2).join("|") === "Doing|Done" ? true : null;
            },
            { label: "the restored declaration renders in its declared order" },
          );
        } catch (cause) {
          throw new Error(
            `the declaration did not come back. lanes=${JSON.stringify(await laneValues(s))} ` +
              `cards=${JSON.stringify(await cardMap(s))}\n` +
              `Alpha:\n${await noteBytes(s, alpha)}\n` +
              `added:\n${await noteBytes(s, newCardId)}\n${(cause as Error).message}`,
          );
        }

        // A note the restore could NOT put back is named rather than counted as
        // restored: the report carries one line per such note.
        const addedBytes = await noteBytes(s, newCardId);
        if (!addedBytes.includes("status: Doing")) {
          const named = await s.findElements(
            testIdSelector("view.board-bulk-report") +
              ` p[data-note-id="${newCardId}"]`,
          );
          expect(
            named.length,
            `a note the restore could not put back is named in the report\n${addedBytes}`,
          ).toBe(1);
        }
      },
    );
  });
});
