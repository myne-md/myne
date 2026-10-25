// Saved-view BOARD drag flow (phone). The board is the ONE renderer mobile does
// not have its own copy of: `MobileViewRenderHost` mounts the desktop module,
// because a board is a projection over notes and a second implementation would
// be a second answer to "which lane is this card in".
//
// So what this spec holds is the two decisions that make a touch drag safe to
// ship, driven through the real gesture rather than by calling the reducer:
//
//   1. **A release resolves to a LANE VALUE, and the write names it.** The card
//      is placed optimistically, so the pixels agree whether or not the write
//      went to the right lane; the recorded `note_set_field` arguments are the
//      only honest assertion. One gesture, one command, one field, one note.
//   2. **A refusal puts the card back where the NOTE says it is.** The line
//      names the lane it went back to, not the lane it failed to reach.
//
// The device itself is not driven here: this tier is desktop Chromium against a
// mock IPC, which is why the touch DEVICE verdict lives on the manual roster.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";
import type { SavedView } from "../../../src/lib/prefs";

const NOTES = [
  { id: "n1", text: "---\ntitle: Alpha\nstatus: Todo\n---\n" },
  { id: "n2", text: "---\ntitle: Beta\nstatus: Doing\n---\n" },
];

/** A board over `status`, with a DECLARED order that includes an empty lane: the
 *  empty one is a drop target, not a tidy-up opportunity. */
const BOARD_VIEW: SavedView = {
  id: "v-board",
  name: "Status board",
  view_type: "board",
  filters: { kind: "all" },
  group_by: "status",
  write_fields: ["status"],
  lanes: ["Todo", "Doing", "Done"],
  version: 1,
};

const PROPERTY_VALUES = {
  status: [
    ["n1", { key: "status", type: "string", value: "Todo" }],
    ["n2", { key: "status", type: "string", value: "Doing" }],
  ] as Array<[string, { key: string; type: string; value?: string }]>,
};

const CARD = (noteId: string) =>
  `[data-testid="view.card-slot"][data-note-id="${noteId}"]`;

async function openBoard(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Views" }).first().click();
  await page.getByText("Status board").click();
  await expect(page.getByTestId("view.board")).toBeVisible();
}

/** Press the card, travel past the drag threshold, release over `laneValue`.
 *  Real input, so the browser generates the pointer events the board listens
 *  for: the same path a finger drives, with no touch-specific branch.
 *
 *  The release point is CLAMPED into the viewport on purpose. The lanes strip is
 *  wider than a phone (each lane is a fixed column), so a lane's own centre sits
 *  off-screen, and a pointer outside the viewport hits nothing: the release then
 *  looks like a gesture that never happened rather than a failed drop. */
async function dragCardTo(
  page: import("@playwright/test").Page,
  noteId: string,
  laneValue: string,
): Promise<void> {
  const card = page.locator(CARD(noteId));
  const lane = page.locator(`[data-testid="view.lane"][data-lane-value="${laneValue}"]`);
  const from = await card.boundingBox();
  const to = await lane.boundingBox();
  const viewport = page.viewportSize();
  if (from === null || to === null || viewport === null) {
    throw new Error("card or lane is not laid out");
  }
  const dropX = Math.min(to.x + to.width / 2, viewport.width - 16);
  const dropY = Math.min(to.y + 48, viewport.height - 16);
  const pressX = from.x + from.width / 2;
  const pressY = from.y + from.height / 2;
  // A card that is VISIBLE is not necessarily pressable: the Views sheet closes
  // with a fading scrim that still takes the pointer, so a press sent the moment
  // the board appears lands on the scrim and the gesture never starts. Wait for
  // the card itself to be the hit target, which is the property that matters.
  await expect
    .poll(() =>
      page.evaluate(
        ([x, y]) =>
          document.elementFromPoint(x, y)?.closest(
            '[data-testid="view.card-slot"]',
          ) !== null,
        [pressX, pressY],
      ),
    )
    .toBe(true);
  await page.mouse.move(pressX, pressY);
  await page.mouse.down();
  // The pauses are the frames a real gesture spans, and they are load-bearing
  // rather than polite: the press arms the gesture in React state, and the
  // release resolves a drop against the DRAGGING state the move committed. Sending
  // all three in one tick is a gesture no hand can make, and it reads as a board
  // that ignored the drag.
  await page.waitForTimeout(80);
  await page.mouse.move(dropX, dropY, { steps: 8 });
  await page.waitForTimeout(80);
  await page.mouse.up();
}

const fieldWrites = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      ((window as unknown as { __noteSetFields?: Array<Record<string, unknown>> })
        .__noteSetFields ?? []) as Array<Record<string, unknown>>,
  );

test.describe("saved-view board drag (phone)", () => {
  test("a drag writes one field, anchored on the lane the card was rendered in", async ({
    page,
  }) => {
    await installMockIpc(page, {
      notes: NOTES,
      savedViews: [BOARD_VIEW],
      propertyValues: PROPERTY_VALUES,
    });
    await openBoard(page);

    // The declared lanes render in order, and the empty one still renders.
    await expect(page.getByTestId("view.lane")).toHaveCount(3);
    const done = page.locator('[data-testid="view.lane"][data-lane-value="Done"]');
    await expect(done.getByTestId("view.lane-empty")).toBeVisible();
    await expect(
      page.locator('[data-lane-value="Todo"] ' + CARD("n1")),
    ).toBeVisible();

    await dragCardTo(page, "n1", "Doing");

    // The WRITE, not the pixels: one command, the view's own field, the value
    // the card was rendered with as the precondition and the lane it was
    // dropped on as the new one.
    await expect
      .poll(async () => (await fieldWrites(page)).length)
      .toBe(1);
    const [write] = await fieldWrites(page);
    expect(write).toMatchObject({
      noteId: "n1",
      viewId: "v-board",
      field: "status",
      expectedValue: "Todo",
      newValue: "Doing",
    });

    // And the card is where the gesture put it.
    await expect(
      page.locator('[data-lane-value="Doing"] ' + CARD("n1")),
    ).toBeVisible();
    await expect(
      page.locator('[data-lane-value="Todo"] ' + CARD("n1")),
    ).toHaveCount(0);
  });

  test("a refused drag puts the card back in the lane the note reports", async ({
    page,
  }) => {
    await installMockIpc(page, {
      notes: NOTES,
      savedViews: [BOARD_VIEW],
      propertyValues: PROPERTY_VALUES,
      // The host's own refusal: the value on disk is no longer the one the
      // board read, which is the ordinary way a drag loses a race.
      fieldWriteRefusal: { kind: "FieldChanged" },
    });
    await openBoard(page);

    await dragCardTo(page, "n1", "Doing");

    // The attempt reached the host (so this is a refusal, not a gesture that
    // never fired)…
    await expect.poll(async () => (await fieldWrites(page)).length).toBe(1);
    // …and the line says why AND where the card went back to.
    const refusal = page.getByTestId("view.board-refusal");
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText("that field changed somewhere else");
    await expect(refusal).toContainText("back in Todo");
    // The card is in the lane the NOTE still carries.
    await expect(
      page.locator('[data-lane-value="Todo"] ' + CARD("n1")),
    ).toBeVisible();
    await expect(
      page.locator('[data-lane-value="Doing"] ' + CARD("n1")),
    ).toHaveCount(0);
  });
});
