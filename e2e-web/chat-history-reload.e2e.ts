// A seeded conversation survives a page reload, and a deletion survives one
// too (myne-md/myne#675, task 12).
//
// # Why this scenario seeds rather than sends
//
// The agent plugin is `Class::Unsupported` on web, so no run can START in this
// lane. The composer names the missing backend and sending is refused before
// anything is written. Seeding the at-rest bytes (`vault.chats` +
// `chats/<id-hex>`, minted by `core/examples/emit-chats-fixture.rs`) is
// therefore the only honest route into a conversation here, exactly as
// `unlock-from-fixture.e2e.ts` seeds `vault.meta` for unlock. Sending is the
// desktop lane's property (same shared tree, tauri-driver suite, task 14).
//
// # What is web-specific about it
//
// Everything asserted after the reload: the roster and the conversation file
// are OPFS bytes read back through the container (`vault.chats.a` Doubled,
// `chats/<id>` SingleLive), and a reload that lost them would be a web-only
// failure. The desktop client never re-reads its vault from scratch. The
// delete half pins the tombstone the same way: gone before the reload, still
// gone after it.
//
// # What this does NOT assert, and why
//
// Continuing the conversation (typing + sending) is refused on web by
// capability, and asserting the refusal text here would duplicate
// `capability-gating.e2e.ts`. Opening the conversation proves the read path;
// the write path for new turns is exercised wherever runs can start.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";
import type { Element, Session } from "./support/session";
import { loadVaultFixture, seedVault } from "./support/opfs-seed";
// Shared with the desktop lane (same overlay, same testids): the importer
// onboarding offer covers the tab strip on a fresh profile and would eat every
// pointer click below. Dismissed per mount: the offer is a first-editor
// overlay and this fixture vault holds no notes.
import { dismissImporterOfferIfPresent } from "../e2e/support/flows";
// The right SidebarPane (and therefore the ai-chat tab strip) mounts only while
// a NOTE tab is focused (`Editor.tsx`). The fixture vault holds none, so a note
// is created after the first unlock and reopened after each reload.
import { createNote } from "./support/flows";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
const SYNC_ORIGIN = "https://sync.example.test";
const UNLOCK_TIMEOUT_MS = 30_000;
const FIXTURE_PATH = "e2e-web/fixtures/chats-history.json";
const TITLE = "Fixture question about tea";
const ANSWER = "Fixture answer: start with last year.";

async function unlock(session: Session, password: string): Promise<void> {
  const field = await session.waitForElement('[data-testid="unlock.password-input"]', {
    timeoutMs: UNLOCK_TIMEOUT_MS,
  });
  await field.sendKeys(password);
  await (await session.findElement('[data-testid="unlock.submit"]')).click();
  await session.waitForElement('[data-testid="editor.bottom-bar"]', {
    timeoutMs: UNLOCK_TIMEOUT_MS,
  });
  // A desktop-sized viewport: the headless default is 800x600, at which the
  // right panel collapses and its tab strip stops being pointer-reachable.
  // Whether a control is reachable by pointer at a given viewport is a11y's
  // domain; this scenario is about what the history panel reads and writes.
  await session.setWindowRect({ width: 1440, height: 900 });
  await dismissImporterOfferIfPresent(session);
}

/**
 * Put a NOTE tab on screen so the right SidebarPane mounts.
 *
 * First unlock: the fixture holds no notes, so one is created. After a reload
 * the note survives but is not re-opened (same routing fact as
 * `refresh-mid-edit.e2e.ts`), so the existing row is clicked instead of making
 * a second note.
 */
async function ensureNoteOpen(session: Session): Promise<void> {
  const rows = await session.findElements('[data-testid="notes.row"]');
  if (rows.length === 0) {
    await createNote(session);
  } else {
    await session.execute(
      "document.querySelector('[data-testid=\"notes.row\"]').click();",
    );
    await session.waitForElement('[data-testid="editor.content"] .cm-content', {
      timeoutMs: 20_000,
    });
  }
  await session.waitForElement('[data-testid="editor.sidebar-right"]', {
    timeoutMs: 15_000,
  });
}

/** Click the ai-chat tab in the right-panel tab strip. */
async function openAiChatTab(session: Session): Promise<void> {
  const tabs: Element[] = await session.byTestIdAll("editor.right-panel-tab");
  let target: Element | null = null;
  for (const tab of tabs) {
    if ((await tab.attribute("data-panel-tab-id")) === "ai-chat") {
      target = tab;
      break;
    }
  }
  expect(target, "the ai-chat tab is in the right-panel strip").not.toBeNull();
  await target!.click();
}

/** The history modal lists exactly the seeded conversation. */
async function expectSeededListed(session: Session): Promise<void> {
  await (await session.byTestId("ai.history-button")).click();
  const list = await session.byTestId("ai.conversation-list");
  expect(await list.textContent()).toContain(TITLE);
  const rows = await session.byTestIdAll("ai.conversation-row");
  expect(rows.length).toBe(1);
}

describeE2E("a seeded conversation survives a reload, and a deletion too", () => {
  it("lists, opens, keeps across reload, and deletes the seeded conversation", async () => {
    const vault = loadVaultFixture(FIXTURE_PATH);
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    let browser: Awaited<ReturnType<typeof newBrowserSession>> | undefined;
    try {
      browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      const { session } = browser;

      await session.navigate(`${server.origin}/__seed`);
      await seedVault(session, vault);
      await session.navigate(`${server.origin}/`);
      await unlock(session, vault.password);

      // The roster lists the seeded conversation; opening it renders the
      // persisted turns: the read path, not just the roster row.
      await ensureNoteOpen(session);
      await openAiChatTab(session);
      await expectSeededListed(session);
      await (await session.byTestId("ai.conversation-open")).click();
      const before = await (await session.byTestId("ai.transcript")).textContent();
      expect(before).toContain(TITLE);
      expect(before).toContain(ANSWER);

      // Reload: unlock again, and the conversation is still listed AND still
      // opens with its turns. The OPFS read path, not the pre-reload RAM.
      await session.navigate(`${server.origin}/`);
      await unlock(session, vault.password);
      await ensureNoteOpen(session);
      await openAiChatTab(session);
      await expectSeededListed(session);
      await (await session.byTestId("ai.conversation-open")).click();
      const retext = await (await session.byTestId("ai.transcript")).textContent();
      expect(retext).toContain(ANSWER);

      // Delete: confirm, the list empties, and a second reload keeps it empty
      // (the tombstone persists; no resurrection).
      await (await session.byTestId("ai.history-button")).click();
      await (await session.byTestId("ai.conversation-delete")).click();
      await (await session.byTestId("ai.conversation-delete-confirm")).click();
      await session.waitForElement('[data-testid="ai.history-empty"]', {
        timeoutMs: 10_000,
      });

      await session.navigate(`${server.origin}/`);
      await unlock(session, vault.password);
      await ensureNoteOpen(session);
      await openAiChatTab(session);
      await (await session.byTestId("ai.history-button")).click();
      await session.waitForElement('[data-testid="ai.history-empty"]', {
        timeoutMs: 10_000,
      });
    } finally {
      await browser?.teardown().catch(() => {});
      await server.close();
    }
  });
});
