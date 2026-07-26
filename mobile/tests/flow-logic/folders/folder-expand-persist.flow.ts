// Flow-logic: the sidebar folder-expand set survives a restart (MYND-561, the
// mobile port of desktop's MYND-455). Headless Chromium + mock IPC — NOT
// end-to-end.
//
// The set rides the `vault.workspace` container (MYW1, §9.7). Writes happen at
// mobile's graceful-exit analogs ONLY — app-background and `lockVault()` — never
// per toggle, so the blob's mtime cannot become a folder-toggle activity log
// (desktop's design-grill 2026-06-01 Q1 property, preserved). That cadence is
// itself asserted here: a toggle alone must produce NO write.
//
// The restore half is a real round-trip rather than two independent assertions:
// phase 1 captures the descriptor the app actually wrote, phase 2 re-installs the
// mock seeded with THAT descriptor and reloads, so a drift between the writer and
// the reader fails the test instead of hiding between two fixtures.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const NOTE_IN_FOLDER = "note-expand-1";
const ROOT_NOTE = "note-expand-root";
const BODIES = {
  [NOTE_IN_FOLDER]: `---\nfolder: Projects/\ntitle: Roadmap\n---\n\nDraft.\n`,
  [ROOT_NOTE]: `---\ntitle: Loose\n---\n\nUnfiled.\n`,
};
/** `folderKey("Projects/")` — the folded identity the set is keyed by. */
const PROJECTS_KEY = "projects/";

const folderRow = (page: Page, name: string) =>
  page.locator(`[data-testid="notes.folder-row"][data-folder-path="${name}"]`);
const noteRows = (page: Page) => page.getByTestId("notes.row");

const workspaceWrites = (page: Page) =>
  page.evaluate(() => (window as unknown as { __workspaceWrites?: string[] }).__workspaceWrites ?? []);

/** The app-background seam: the WebView's `visibilitychange` → hidden. */
async function background(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** The terminal seam: `pagehide` (an OS kill of a backgrounded app). */
async function pageHide(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
}

test.describe("folder expand/collapse persistence", () => {
  test("a fresh vault opens collapsed — desktop parity", async ({ page }) => {
    await installMockIpc(page, { noteIds: [NOTE_IN_FOLDER, ROOT_NOTE], noteBodies: BODIES });
    await page.goto("/");

    // The folder row is there but folded, so its note is not rendered; the
    // unfiled note is (root rows do not hide behind a folder).
    await expect(folderRow(page, "Projects")).toHaveAttribute("data-collapsed", "true");
    await expect(noteRows(page)).toHaveCount(1);
  });

  test("a toggle alone writes nothing — the blob mtime is not a toggle log", async ({ page }) => {
    await installMockIpc(page, { noteIds: [NOTE_IN_FOLDER, ROOT_NOTE], noteBodies: BODIES });
    await page.goto("/");

    await folderRow(page, "Projects").click();
    await expect(folderRow(page, "Projects")).toHaveAttribute("data-collapsed", "false");
    // The in-folder note is now visible — the toggle took effect in the UI…
    await expect(noteRows(page)).toHaveCount(2);
    // …but nothing was persisted yet.
    expect(await workspaceWrites(page)).toEqual([]);
  });

  test("expand → background → reopen restores the expanded folder", async ({ page }) => {
    await installMockIpc(page, { noteIds: [NOTE_IN_FOLDER, ROOT_NOTE], noteBodies: BODIES });
    await page.goto("/");

    await folderRow(page, "Projects").click();
    await expect(folderRow(page, "Projects")).toHaveAttribute("data-collapsed", "false");

    await background(page);

    // One write, carrying the folder's FOLDED key (not its display path).
    await expect.poll(() => workspaceWrites(page)).toHaveLength(1);
    const written = (await workspaceWrites(page))[0]!;
    expect(JSON.parse(written).expandedFolders).toEqual([PROJECTS_KEY]);

    // "Reopen the app": re-seed the mock with the descriptor the app itself
    // wrote, then reload. The later init script wins, so the reloaded page boots
    // against that persisted blob.
    await installMockIpc(page, {
      noteIds: [NOTE_IN_FOLDER, ROOT_NOTE],
      noteBodies: BODIES,
      workspaceDescriptor: written,
    });
    await page.reload();

    await expect(folderRow(page, "Projects")).toHaveAttribute("data-collapsed", "false");
    await expect(noteRows(page)).toHaveCount(2);
  });

  test("collapsing back persists as collapsed, not as 'nothing saved'", async ({ page }) => {
    // The polarity trap: mobile used to track the COMPLEMENT (`collapsedFolders`),
    // which serialized an all-collapsed sidebar to the same omit-when-empty bytes
    // as a cold vault — so "collapse everything" was silently undone on restart.
    await installMockIpc(page, {
      noteIds: [NOTE_IN_FOLDER, ROOT_NOTE],
      noteBodies: BODIES,
      workspaceDescriptor: JSON.stringify({ expandedFolders: [PROJECTS_KEY] }),
    });
    await page.goto("/");
    await expect(folderRow(page, "Projects")).toHaveAttribute("data-collapsed", "false");

    await folderRow(page, "Projects").click(); // collapse it
    await expect(folderRow(page, "Projects")).toHaveAttribute("data-collapsed", "true");
    await pageHide(page);

    await expect.poll(() => workspaceWrites(page)).toHaveLength(1);
    const written = (await workspaceWrites(page))[0]!;
    // Field omitted (byte-compat), and re-reading it yields the collapsed state.
    expect(JSON.parse(written).expandedFolders).toBeUndefined();

    await installMockIpc(page, {
      noteIds: [NOTE_IN_FOLDER, ROOT_NOTE],
      noteBodies: BODIES,
      workspaceDescriptor: written,
    });
    await page.reload();
    await expect(folderRow(page, "Projects")).toHaveAttribute("data-collapsed", "true");
    await expect(noteRows(page)).toHaveCount(1);
  });

  test("a descriptor carrying a desktop pane tree keeps it through a mobile write", async ({ page }) => {
    // Both clients write the same container. A mobile write must splice its field
    // in, never replace the object — else it deletes a desktop user's open tabs.
    const desktopBlob = JSON.stringify({
      slots: [{ id: "s1", name: "Default", root: { kind: "leaf", paneId: "p1", items: [] } }],
      activeId: "s1",
    });
    await installMockIpc(page, {
      noteIds: [NOTE_IN_FOLDER, ROOT_NOTE],
      noteBodies: BODIES,
      workspaceDescriptor: desktopBlob,
    });
    await page.goto("/");

    await folderRow(page, "Projects").click();
    await background(page);

    await expect.poll(() => workspaceWrites(page)).toHaveLength(1);
    const written = JSON.parse((await workspaceWrites(page))[0]!);
    expect(written.slots).toEqual([
      { id: "s1", name: "Default", root: { kind: "leaf", paneId: "p1", items: [] } },
    ]);
    expect(written.activeId).toBe("s1");
    expect(written.expandedFolders).toEqual([PROJECTS_KEY]);
  });

  test("a malformed descriptor degrades to collapsed instead of breaking the list", async ({ page }) => {
    await installMockIpc(page, {
      noteIds: [NOTE_IN_FOLDER, ROOT_NOTE],
      noteBodies: BODIES,
      workspaceDescriptor: "{ this is not json",
    });
    await page.goto("/");

    await expect(folderRow(page, "Projects")).toHaveAttribute("data-collapsed", "true");
    await expect(noteRows(page)).toHaveCount(1);
  });
});
