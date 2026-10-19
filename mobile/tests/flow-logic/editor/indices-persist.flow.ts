// Flow-logic: the persisted structured index (`vault.indices` / `MYI1`) is
// HYDRATED on unlock and WRITTEN at an exit seam (myne-md/myne#722).
//
// The unit spec (`mobile/tests/vault-indices-lifecycle.test.ts`) pins the
// module in isolation. What it cannot see is the wiring, and the wiring is the
// whole feature: a client that hydrates and then lets the first sweep re-send
// the entire vault has the blob and none of its benefit, and a client that
// writes on every sweep turns the blob's mtime into an editing-activity log
// (`protocol.md` §9.8.5; the cadence is the exit seams).
//
// So these assertions are CALL COUNTS on the index feed, the same currency
// `save-delta.flow.ts` uses, plus the hydrate count itself. Headless Chromium
// against the dev server with mock IPC, NOT an end-to-end suite.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

interface IndexFeed {
  noteReads: string[];
  indicesApplies: string[];
  indicesRemoves: string[];
  indicesHydrates: number;
  indicesPersists: number;
  searchReplaces: number[];
  searchApplies: string[][];
  searchRemoves: string[];
}

const NOTES = [
  { id: "note-a", text: "---\ntitle: A\n---\n\nbody a\n" },
  { id: "note-b", text: "---\ntitle: B\n---\n\nbody b\n" },
];

const EDITED_ID = "note-a";

function readFeed(page: Page): Promise<IndexFeed> {
  return page.evaluate(
    () =>
      (window as unknown as { __indexFeed?: IndexFeed }).__indexFeed ?? {
        noteReads: [],
        indicesApplies: [],
        indicesRemoves: [],
        indicesHydrates: 0,
        indicesPersists: 0,
        searchReplaces: [],
        searchApplies: [],
        searchRemoves: [],
      },
  );
}

async function boot(
  page: Page,
  opts: { indicesPersisted: boolean; indicesHydrateDelayMs?: number; indicesStaleExtra?: string[] },
): Promise<void> {
  await installMockIpc(page, {
    notes: NOTES,
    indicesPersisted: opts.indicesPersisted,
    indicesHydrateDelayMs: opts.indicesHydrateDelayMs,
    indicesStaleExtra: opts.indicesStaleExtra,
  });
  await page.goto("/");
  await expect(page.getByTestId("workspace.app-header")).toBeVisible();
  // The sweep is debounced 400ms; let the boot pass finish before measuring.
  await page.waitForTimeout(1500);
}

test.describe("MYI1 persisted index (phone)", () => {
  test("a covered blob applies nothing on unlock, and is written only at an exit seam", async ({
    page,
  }) => {
    // A real hydrate is IPC plus vault IO plus an AEAD decode, so it can land
    // after the sweep's 400 ms debounce. The delay is what makes this spec fail
    // on a client whose sweep is NOT gated on the hydrate: the seed would
    // arrive after the whole corpus had already been re-sent.
    await boot(page, { indicesPersisted: true, indicesHydrateDelayMs: 900 });

    const onUnlock = await readFeed(page);
    expect(onUnlock.indicesHydrates).toBe(1);
    // The fast path: the host loaded the records, the tracker was seeded from
    // them, so the first sweep has an empty delta.
    expect(onUnlock.indicesApplies).toHaveLength(0);
    // Nothing to write: the app has not edited anything.
    expect(onUnlock.indicesPersists).toBe(0);

    await page.locator(`[data-testid="notes.row"][data-note-id="${EDITED_ID}"]`).click();
    await expect(page.getByTestId("editor.top-bar")).toBeVisible();
    await page.locator(".cm-content").getByText("body a").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" edited");
    // Leaving the note saves it; the sweep's body map moves on that write, so
    // the apply is what the save produces rather than what typing produces.
    await page.getByTestId("editor.back").click();
    await page.waitForTimeout(1200);

    const afterEdit = await readFeed(page);
    // One note's work, not the vault's: the seeded tracker means the edit is
    // the only difference the sweep can see.
    expect(afterEdit.indicesApplies).toContain(EDITED_ID);
    expect(afterEdit.indicesApplies).not.toContain("note-b");
    // An edit alone does not write the blob (protocol.md §9.8.5: the cadence
    // is the exit seams, never the edit).
    expect(afterEdit.indicesPersists).toBe(0);

    // The ordinary phone exit: the app is backgrounded rather than closed.
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await page.waitForTimeout(800);

    const onExit = await readFeed(page);
    expect(onExit.indicesPersists).toBe(1);
  });

  test("a hydrated record whose note left the live set is removed, not kept", async ({ page }) => {
    await boot(page, { indicesPersisted: true, indicesStaleExtra: ["note-trashed"] });

    const feed = await readFeed(page);
    // The Rust store is trash-blind (§9.8.4), so the caller owns this half: a
    // stale id outside the live corpus has no sweep to report it, and the
    // record it left behind would outlive the note's liveness on every unlock.
    expect(feed.indicesRemoves).toContain("note-trashed");
    for (const note of NOTES) expect(feed.indicesRemoves).not.toContain(note.id);
  });

  test("a cold vault reports every note stale, so the sweep rebuilds it", async ({ page }) => {
    await boot(page, { indicesPersisted: false });

    const feed = await readFeed(page);
    expect(feed.indicesHydrates).toBe(1);
    // §9.8.4's fall-to-rebuild: no blob means every on-disk note is stale, and
    // the sweep re-applies the whole live set. This is the other side of the
    // gate above, and the one that must never silently become "nothing".
    expect(new Set(feed.indicesApplies)).toEqual(new Set(NOTES.map((n) => n.id)));
  });
});
