// Flow-logic: the weekly and monthly palette commands are actually wired
// (myne-md/myne#177).
//
// `mobile/tests/daily.test.ts` covers the resolver, the settings resolution and
// the timezone anchor as pure functions, and every one of those passes while the
// palette entry runs nothing at all. What is NOT covered there is the wiring:
// that the command reaches `openPeriod`, that `openPeriod` reaches the vault
// with a title and a folder that belong to the period asked for, and that the
// second invocation OPENS the note the first one made rather than making a
// second. Deleting the body of `openPeriod` leaves the whole unit suite green.
//
// This is the mobile counterpart of desktop's `e2e/periodic-notes.e2e.ts` `pn1`,
// and it exists because the mobile lanes are the ones CI runs on every commit.
//
// The title assertions are SHAPES, not values. A spec that recomputed the ISO
// week would be the formatter's third implementation asserting against the
// second; what this has to prove is that a weekly command produced a week-shaped
// title in the weekly folder, which no wrong wiring can satisfy by accident.
//
// Headless Chromium against the dev server with mock IPC. NOT end-to-end.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** Bodies `note_create` was handed, in order. */
function noteCreates(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __noteCreates?: string[] }).__noteCreates ?? [],
  );
}

/** Pull one frontmatter field out of a created note's raw text. */
function field(text: string, key: string): string | null {
  const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(text);
  return m === null ? null : m[1]!.trim();
}

/** Two unrelated notes. The count matters: `maybeSeedTestData` spreads a demo
 *  vault under `vite dev` whenever the vault holds one note or fewer, and with
 *  `statefulNoteWrites` on those writes PERSIST, so an empty seed hands the
 *  measured window 38 creates that have nothing to do with this feature. */
const SEED = [
  { id: "note-a", text: "---\ntitle: Alpha\n---\n\nalpha\n" },
  { id: "note-b", text: "---\ntitle: Beta\n---\n\nbeta\n" },
];

async function bootToList(page: Page): Promise<void> {
  // `statefulNoteWrites` is the whole point: without it a created note is
  // discarded, `note_list` never returns it, and the second run would create a
  // second note for a reason that has nothing to do with the resolver.
  await installMockIpc(page, { notes: SEED, statefulNoteWrites: true });
  await page.goto("/");
  await expect(page.getByTestId("workspace.app-header")).toBeVisible();
  // Drop whatever boot recorded, so what follows is measured alone.
  await page.evaluate(() => {
    (window as unknown as { __noteCreates?: string[] }).__noteCreates = [];
  });
}

/** Leave the editor the command opened; the palette lives on the list chrome. */
async function backToList(page: Page): Promise<void> {
  await page.getByTestId("editor.back").click();
  await expect(page.getByTestId("workspace.app-header")).toBeVisible();
}

async function runPaletteCommand(page: Page, id: string): Promise<void> {
  await page.getByRole("button", { name: "Command palette" }).click();
  const row = page.locator(`[data-testid="palette.command"][data-command-id="${id}"]`);
  await expect(row).toBeVisible();
  await row.click();
}

test.describe("the periodic-note palette commands reach the vault", () => {
  test("weekly creates a week-titled note in the weekly folder", async ({ page }) => {
    await bootToList(page);
    await runPaletteCommand(page, "weekly");

    await expect.poll(async () => (await noteCreates(page)).length).toBe(1);
    const created = (await noteCreates(page))[0]!;
    expect(field(created, "folder")).toBe("Weekly/");
    // `gggg-[W]ww` is the default weekly format. Shape, not value.
    expect(field(created, "title")).toMatch(/^\d{4}-W\d{2}$/);
  });

  test("monthly creates a month-titled note in the monthly folder", async ({ page }) => {
    await bootToList(page);
    await runPaletteCommand(page, "monthly");

    await expect.poll(async () => (await noteCreates(page)).length).toBe(1);
    const created = (await noteCreates(page))[0]!;
    expect(field(created, "folder")).toBe("Monthly/");
    expect(field(created, "title")).toMatch(/^\d{4}-\d{2}$/);
  });

  test("weekly and monthly are two different notes, not one", async ({ page }) => {
    // The failure this catches is a period argument dropped somewhere between
    // the palette entry and the resolver: both commands would then produce the
    // daily note, or the same note twice, and every per-period unit test would
    // still pass.
    await bootToList(page);
    await runPaletteCommand(page, "weekly");
    await expect.poll(async () => (await noteCreates(page)).length).toBe(1);
    // The command opens the note, and the compact layout replaces the list with
    // the editor, so the palette is only reachable again from the list.
    await backToList(page);
    await runPaletteCommand(page, "monthly");
    await expect.poll(async () => (await noteCreates(page)).length).toBe(2);

    const [week, month] = await noteCreates(page);
    expect(field(week!, "folder")).toBe("Weekly/");
    expect(field(month!, "folder")).toBe("Monthly/");
    expect(field(week!, "title")).not.toBe(field(month!, "title"));
  });

  test("running weekly twice opens the note rather than making a second", async ({ page }) => {
    // The idempotence the whole feature rests on: the resolver matches on folder
    // plus title and nothing else, so a fold that stopped matching, or a title
    // that moved between the two runs, shows up here as a second create.
    await bootToList(page);
    await runPaletteCommand(page, "weekly");
    await expect.poll(async () => (await noteCreates(page)).length).toBe(1);
    await expect(page.getByTestId("editor.top-bar")).toBeVisible();

    await backToList(page);
    await runPaletteCommand(page, "weekly");
    await expect(page.getByTestId("editor.top-bar")).toBeVisible();

    expect(await noteCreates(page)).toHaveLength(1);
  });
});
