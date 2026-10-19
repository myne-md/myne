// Flow-logic: saving one note costs one note's work (myne-mobile#41).
//
// The defect this pins was invisible from every screen. Saving a note called the
// universal `refresh()`, which re-read and re-decrypted EVERY note in the vault,
// installed a fresh `bodies` map, and thereby re-fired both index feeds over the
// whole corpus: one `extractRecord` parse plus one `vault_indices_apply` per
// note, and the entire plaintext corpus back through `search_index_replace`. The
// list looked right the whole time; only the clock knew, and it scaled with the
// vault rather than with the edit.
//
// So these assertions are COUNTS, not appearances. They fail loudly on a
// regression that no rendering assertion anywhere would notice.
//
// Headless Chromium against the dev server with mock IPC — NOT an end-to-end
// suite.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

interface IndexFeed {
  noteReads: string[];
  indicesApplies: string[];
  indicesRemoves: string[];
  /** MYI1 hydrate / persist counts (myne-md/myne#722). */
  indicesHydrates: number;
  indicesPersists: number;
  searchReplaces: number[];
  searchApplies: string[][];
  searchRemoves: string[];
}

/** Enough notes that whole-vault work is unmistakable against one note's work. */
const CORPUS_SIZE = 30;
const EDITED_ID = "note-07";

const CORPUS = Array.from({ length: CORPUS_SIZE }, (_, i) => {
  const n = String(i).padStart(2, "0");
  return {
    id: `note-${n}`,
    text: `---\ntitle: Note ${n}\nupdated: 2026-07-01T10:00:00.000Z\n---\n\nbody line ${n}\n`,
  };
});

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

/** Drop everything the boot sweep recorded, so what follows is measured alone. */
function resetFeed(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as { __indexFeed?: IndexFeed };
    if (w.__indexFeed === undefined) return;
    w.__indexFeed.noteReads.length = 0;
    w.__indexFeed.indicesApplies.length = 0;
    w.__indexFeed.indicesRemoves.length = 0;
    w.__indexFeed.searchReplaces.length = 0;
    w.__indexFeed.searchApplies.length = 0;
    w.__indexFeed.searchRemoves.length = 0;
  });
}

async function bootToList(page: Page): Promise<void> {
  await installMockIpc(page, { notes: CORPUS });
  await page.goto("/");
  await expect(page.getByTestId("workspace.app-header")).toBeVisible();
  // Both index feeds are debounced 400ms; let the boot sweep finish so it is not
  // still running when the measured window opens.
  await page.waitForTimeout(1200);
}

async function openEditAndLeave(page: Page): Promise<void> {
  await page.locator(`[data-testid="notes.row"][data-note-id="${EDITED_ID}"]`).click();
  await expect(page.getByTestId("editor.top-bar")).toBeVisible();
  await resetFeed(page);

  // Click the body LINE rather than `.cm-content`: the live-preview frontmatter
  // renders a Properties widget at the content's center, and a center-click
  // types into that widget instead of the note.
  await page.locator(".cm-content").getByText("body line 07").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" — edited");
  await page.getByTestId("editor.back").click();

  await expect(page.getByTestId("workspace.app-header")).toBeVisible();
  await page.waitForTimeout(1200); // past both debounces
}

test.describe("saving one note does not sweep the vault", () => {
  test("the save reads no other note", async ({ page }) => {
    await bootToList(page);
    await openEditAndLeave(page);

    // The body that was just written is already in hand; re-reading the vault to
    // learn one row is the whole defect. At most the edited note is re-read.
    const { noteReads } = await readFeed(page);
    expect(noteReads.filter((id) => id !== EDITED_ID)).toEqual([]);
    expect(noteReads.length).toBeLessThanOrEqual(1);
  });

  test("the save applies exactly one vault-indices record", async ({ page }) => {
    await bootToList(page);
    await openEditAndLeave(page);

    const { indicesApplies, indicesRemoves } = await readFeed(page);
    expect(indicesApplies).toEqual([EDITED_ID]);
    expect(indicesRemoves).toEqual([]);
  });

  test("the save feeds the search index a delta, not the corpus", async ({ page }) => {
    await bootToList(page);
    await openEditAndLeave(page);

    const { searchApplies, searchReplaces } = await readFeed(page);
    // A whole-corpus replace after boot is exactly the O(vault) leg being
    // removed — the seed happens once, on unlock, and never again per save.
    expect(searchReplaces).toEqual([]);
    expect(searchApplies).toEqual([[EDITED_ID]]);
  });

  test("the boot sweep still seeds both indices for the whole corpus", async ({ page }) => {
    // The counterpart assertion: narrowing the save path must not narrow the
    // unlock path, or the vault opens with indices that answer for nothing.
    await bootToList(page);

    const ids = CORPUS.map((n) => n.id);
    const feed = await readFeed(page);

    // On the READ side this asserts coverage, not a count: the dev server runs
    // under React.StrictMode, which double-invokes the boot effect, so the
    // reads arrive as the corpus twice over. That is a harness artefact — the
    // production build mounts once — and pinning the exact number here would
    // pin StrictMode rather than the app.
    expect([...new Set(feed.noteReads)].sort()).toEqual([...ids].sort());

    // The index feeds, by contrast, ARE exact — they are debounced and
    // delta-tracked, so the repeated load collapses: each note is applied once
    // and the corpus is seeded once, no matter how many times the load ran.
    expect(feed.indicesApplies.sort()).toEqual([...ids].sort());
    expect(feed.searchReplaces).toEqual([CORPUS_SIZE]);
  });
});
