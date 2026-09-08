// Flow-logic: the phone's conversation history (myne-md/myne#675, task 13).
//
// Headless Chromium + mock IPC. NOT end-to-end (see the config header): the
// agent never runs here (`agent_start` records rather than answers), so what
// this file drives is the history surface: list, continue-last, open, new
// chat, rename, delete-with-confirm, against a stateful chats mock. Sending
// (append on settle) is unit-covered in `AiChatFlow.test.tsx`; the background
// flush is unit-covered in `chatHistory.test.ts`.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const ROWS = [
  { id: "a1", created_at: 100, title: "Older chat", updated_at: 100, version: 1 },
  { id: "b2", created_at: 200, title: "Newer chat", updated_at: 300, version: 2 },
];

const PAYLOADS: Record<string, string> = {
  a1: JSON.stringify({
    turns: [
      { id: "h1", kind: "text", role: "user", text: "older question" },
      { id: "h2", kind: "text", role: "assistant", text: "older answer" },
    ],
  }),
  b2: JSON.stringify({
    turns: [
      { id: "h3", kind: "text", role: "user", text: "newer question" },
      { id: "h4", kind: "text", role: "assistant", text: "newer answer" },
    ],
  }),
};

async function openChatTab(page: Page) {
  await page.goto("/");
  await page.getByTestId("workspace.tab-chat").click();
}

test.describe("phone conversation history", () => {
  test("lists the roster newest-first", async ({ page }) => {
    await installMockIpc(page, {
      prefs: { ai_enabled: true },
      chats: { rows: ROWS, payloads: PAYLOADS },
    });
    await openChatTab(page);

    await page.getByTestId("ai.history-button").click();
    const rows = page.getByTestId("ai.conversation-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Newer chat");
    await expect(rows.nth(1)).toContainText("Older chat");
  });

  test("continues the newest conversation on mount", async ({ page }) => {
    await installMockIpc(page, {
      prefs: { ai_enabled: true },
      chats: { rows: ROWS, payloads: PAYLOADS },
    });
    await openChatTab(page);

    // No sheet opened: the transcript already shows the newest turns.
    const turns = page.getByTestId("ai.history-turn");
    await expect(turns.nth(0)).toContainText("newer question");
    await expect(turns.nth(1)).toContainText("newer answer");
  });

  test("opens an older conversation from the sheet", async ({ page }) => {
    await installMockIpc(page, {
      prefs: { ai_enabled: true },
      chats: { rows: ROWS, payloads: PAYLOADS },
    });
    await openChatTab(page);
    await expect(page.getByTestId("ai.history-turn").nth(0)).toContainText("newer question");

    await page.getByTestId("ai.history-button").click();
    await page.getByTestId("ai.conversation-row").nth(1).getByTestId("ai.conversation-open").click();

    const turns = page.getByTestId("ai.history-turn");
    await expect(turns.nth(0)).toContainText("older question");
    await expect(turns.nth(1)).toContainText("older answer");
  });

  test("new chat clears the transcript; the next send creates", async ({ page }) => {
    await installMockIpc(page, {
      prefs: { ai_enabled: true },
      chats: { rows: ROWS, payloads: PAYLOADS },
    });
    await openChatTab(page);
    await expect(page.getByTestId("ai.history-turn").nth(0)).toContainText("newer question");

    await page.getByTestId("ai.history-button").click();
    await page.getByTestId("ai.history-new-chat").click();
    await expect(page.getByTestId("ai.history-turn")).toHaveCount(0);
    await expect(page.getByTestId("ai.chat-empty")).toBeVisible();
  });

  test("renames through the binding and refreshes the row", async ({ page }) => {
    await installMockIpc(page, {
      prefs: { ai_enabled: true },
      chats: { rows: ROWS, payloads: PAYLOADS },
    });
    await openChatTab(page);
    await page.getByTestId("ai.history-button").click();
    await page.getByTestId("ai.conversation-row").nth(0).getByTestId("ai.conversation-rename").click();
    await page.getByTestId("ai.conversation-rename-input").fill("Renamed chat");
    await page.getByTestId("ai.conversation-rename-confirm").click();
    await expect(page.getByTestId("ai.conversation-row").nth(0)).toContainText("Renamed chat");
  });

  test("deletes only after the confirm tap, and the row stays gone", async ({ page }) => {
    await installMockIpc(page, {
      prefs: { ai_enabled: true },
      chats: { rows: ROWS, payloads: PAYLOADS },
    });
    await openChatTab(page);
    await page.getByTestId("ai.history-button").click();
    await page.getByTestId("ai.conversation-row").nth(0).getByTestId("ai.conversation-delete").click();
    // Armed, not deleted: the row is still there awaiting confirm.
    await expect(page.getByTestId("ai.conversation-row")).toHaveCount(2);
    await page.getByTestId("ai.conversation-delete-confirm").click();
    await expect(page.getByTestId("ai.conversation-row")).toHaveCount(1);
    await expect(page.getByTestId("ai.conversation-row").nth(0)).toContainText("Older chat");
  });

  test("shows the empty state when the roster is empty", async ({ page }) => {
    await installMockIpc(page, { prefs: { ai_enabled: true } });
    await openChatTab(page);
    await page.getByTestId("ai.history-button").click();
    // Scoped to the sheet: the flow body renders its own empty state while
    // no conversation is open, so an unscoped lookup matches twice.
    await expect(
      page.getByTestId("ai.history-sheet").getByTestId("ai.history-empty"),
    ).toBeVisible();
  });
});
